import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  SchemaError,
  appendUsage,
  describeRepo,
  ensureHome,
  heuristicClosure,
  languageFromFile,
  listEntries,
  loadIndex,
  originFor,
  purgeUsage,
  readEntry,
  readEntryFiles,
  resolveHome,
  resolveOwnership,
  retireEntry,
  saveEntry,
  searchBank,
  toCard,
  toSlug,
} from "../../core/src/index.ts";

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "search":
        return await search(rest);
      case "get":
        return await get(rest);
      case "add":
        return await add(rest);
      case "list":
        return list(rest);
      case "retire":
        return await retire(rest);
      case "doctor":
        return doctor(rest);
      default:
        printHelp();
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof SchemaError) {
      console.error(error.message);
      return 3;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function search(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { limit: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  const query = positionals.join(" ");
  if (!query) {
    console.error("Usage: codebank search <query> [--limit n] [--json]");
    return 1;
  }
  const home = ensureAndHome();
  const limit = Number(values.limit ?? 8);
  const cards = searchBank(home, query, Number.isFinite(limit) ? limit : 8, { targetOrg: describeRepo(process.cwd()).org });
  appendUsage(home, { t: new Date().toISOString(), kind: "search", surface: "cli", query });
  if (values.json) console.log(JSON.stringify(cards, null, 2));
  else if (cards.length === 0) console.log("No matches.");
  else for (const card of cards) console.log(`${card.slug}\t${card.title}\t${card.intent}`);
  return 0;
}

async function get(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error("Usage: codebank get <slug> [--out dir]");
    return 1;
  }
  const home = ensureAndHome();
  const entry = readEntry(home, slug);
  if (!entry) {
    console.error(`No entry named ${slug}.`);
    return 2;
  }
  const files = readEntryFiles(home, slug);
  appendUsage(home, { t: new Date().toISOString(), kind: "shown", surface: "cli", slug });
  if (values.out) {
    for (const file of files) {
      const target = path.join(values.out, file.relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    console.log(`Wrote ${files.length} files to ${values.out}`);
    return 0;
  }
  console.log(JSON.stringify({ card: toCard(entry, files.reduce((sum, file) => sum + file.content.split("\n").length, 0)), files }, null, 2));
  return 0;
}

async function add(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { range: { type: "string" }, title: { type: "string" } },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file || !values.title || !values.range) {
    console.error("Usage: codebank add <file> --range 10:40 --title <title>");
    return 1;
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${file}`);
    return 2;
  }
  const range = parseRange(values.range);
  const closure = heuristicClosure(abs, range);
  const home = ensureAndHome();
  const config = ensureHome(home);
  const entryFile = closure.entryFile;
  const origin = originFor(abs, entryFile, range, "manual");
  const outcome = await saveEntry(
    home,
    {
      slug: toSlug(values.title),
      title: values.title,
      language: languageFromFile(abs),
      entryFile,
      symbols: closure.symbols,
      tags: closure.deps.map((dep) => dep.name.split("/").pop() ?? dep.name).slice(0, 8),
      intent: "",
      deps: closure.deps,
      origin,
      ownership: resolveOwnership(origin.org, config),
    },
    closure.files,
  );
  if (!outcome.ok) {
    console.error(outcome.reason === "secrets" ? "Save blocked. A secret was found." : `Not saved: ${outcome.reason}.`);
    return 1;
  }
  if (closure.warnings.length > 0) for (const warning of closure.warnings) console.error(warning);
  console.log(`Saved ${outcome.entry.slug} with ${closure.files.length} files.`);
  return 0;
}

function list(argv: string[]): number {
  parseArgs({ args: argv, options: {}, allowPositionals: true });
  const home = ensureAndHome();
  const entries = listEntries(home).filter((entry) => entry.status !== "retired");
  if (entries.length === 0) console.log("The bank is empty. Deposit a selection or run codebank add.");
  else for (const entry of entries) console.log(`${entry.slug}\tv${entry.version}\t${entry.title}`);
  return 0;
}

async function retire(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const slug = positionals[0];
  if (!slug) {
    console.error("Usage: codebank retire <slug>");
    return 1;
  }
  const home = ensureAndHome();
  const retired = await retireEntry(home, slug);
  if (!retired) {
    console.error(`No entry named ${slug}.`);
    return 2;
  }
  console.log(`Retired ${slug}.`);
  return 0;
}

function doctor(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { "purge-usage": { type: "boolean" } }, allowPositionals: true });
  const home = ensureAndHome();
  const index = loadIndex(home);
  console.log(`Home: ${home}`);
  console.log("Schema: 1");
  console.log(`Entries: ${listEntries(home).length}`);
  console.log(`Index: ${index.docs.length} documents`);
  if (values["purge-usage"]) {
    purgeUsage(home);
    console.log("Usage log deleted.");
  }
  return 0;
}

function ensureAndHome(): string {
  const home = resolveHome();
  ensureHome(home);
  return home;
}

function parseRange(value: string): { startLine: number; endLine: number } {
  const [start, end] = value.split(":").map((part) => Number(part));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error("Range must look like 10:40, starting at line 1 or later.");
  }
  return { startLine: start, endLine: end };
}

function printHelp(): void {
  console.log(`codebank search <query> [--limit n] [--json]
codebank get <slug> [--out dir]
codebank add <file> --range 10:40 --title <title>
codebank list
codebank retire <slug>
codebank doctor [--purge-usage]`);
}

if (process.argv[1]?.endsWith(`${path.sep}cli.js`)) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
