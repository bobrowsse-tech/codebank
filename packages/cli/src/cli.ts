import fs from "node:fs";
import os from "node:os";
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
  listCandidates,
  mine,
  proposeCandidate,
  retireEntry,
  saveEntry,
  searchBank,
  toCard,
  toSlug,
  acceptCandidate,
  dismissCandidate,
  loadConfig,
} from "../../core/src/index.ts";
import { serveMcp } from "../../mcp/src/server.ts";
import { installSkill } from "./skill.ts";

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
      case "mine":
        return mineCommand(rest);
      case "inbox":
        return inboxCommand(rest);
      case "propose":
        return proposeCommand(rest);
      case "mcp":
        return serveMcp(ensureAndHome());
      case "skill":
        return skillCommand(rest);
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

async function mineCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { roots: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  const home = ensureAndHome();
  const config = loadConfig(home);
  const roots = (values.roots ? values.roots.split(",") : config.scan.roots).map(expandHome);
  const result = await mine(home, { roots });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (result.candidates.length === 0) console.log(`Scanned ${result.files} files in ${result.repos} repos. No new candidates.`);
  else {
    console.log(`Scanned ${result.files} files in ${result.repos} repos in ${Math.round(result.elapsedMs)} ms.`);
    for (const candidate of result.candidates) console.log(`${candidate.id}\t${candidate.score.toFixed(2)}\t${candidate.draft.title}`);
  }
  return 0;
}

async function inboxCommand(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const [action, id] = positionals;
  const home = ensureAndHome();
  if (!action || action === "list") {
    const candidates = listCandidates(home);
    if (candidates.length === 0) console.log("The inbox is empty. Run codebank mine or ask an agent to propose one.");
    else for (const candidate of candidates) console.log(`${candidate.id}\t${candidate.proposedBy}\t${candidate.draft.title}`);
    return 0;
  }
  if (!id) {
    console.error("Usage: codebank inbox list | accept <id> | dismiss <id>");
    return 1;
  }
  if (action === "dismiss") {
    if (!(await dismissCandidate(home, id))) {
      console.error(`No candidate named ${id}.`);
      return 2;
    }
    console.log(`Dismissed ${id}.`);
    return 0;
  }
  if (action === "accept") {
    const outcome = await acceptCandidate(home, id);
    if (!outcome.ok) {
      console.error(outcome.reason === "missing" ? `No candidate named ${id}.` : `Not accepted: ${outcome.reason}.`);
      return outcome.reason === "missing" ? 2 : 1;
    }
    console.log(`Accepted ${outcome.entry.slug}.`);
    return 0;
  }
  console.error("Usage: codebank inbox list | accept <id> | dismiss <id>");
  return 1;
}

async function proposeCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      title: { type: "string" },
      intent: { type: "string" },
      "when-not": { type: "string" },
      tags: { type: "string" },
      files: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  const listed = [...(values.files ?? []), ...positionals];
  if (!values.title || !values.intent || listed.length === 0) {
    console.error("Usage: codebank propose --title <title> --intent <intent> --files a.ts b.ts");
    return 1;
  }
  const files = listed.map((file) => {
    const abs = path.resolve(file);
    return { relPath: path.relative(process.cwd(), abs).split(path.sep).join("/"), content: fs.readFileSync(abs, "utf8") };
  });
  const home = ensureAndHome();
  const outcome = await proposeCandidate(home, {
    title: values.title,
    intent: values.intent,
    whenNot: values["when-not"],
    tags: (values.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    files,
  });
  if (!outcome.ok) {
    console.error(outcome.reason);
    return 1;
  }
  console.log(`Proposed ${outcome.candidate.id}. It stays in the inbox until you accept it.`);
  return 0;
}

function skillCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { target: { type: "string" }, "agents-md": { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals[0] !== "install") {
    console.error("Usage: codebank skill install --target claude|copilot|agents [--agents-md]");
    return 1;
  }
  const target = values.target;
  if (target !== "claude" && target !== "copilot" && target !== "agents") {
    console.error("Target must be claude, copilot, or agents.");
    return 1;
  }
  const destination = installSkill({ target, agentsMd: values["agents-md"] });
  console.log(`Installed the skill at ${destination}.`);
  return 0;
}

function expandHome(root: string): string {
  return root.replace(/^~(?=$|\/)/, os.homedir());
}

function printHelp(): void {
  console.log(`codebank search <query> [--limit n] [--json]
codebank get <slug> [--out dir]
codebank add <file> --range 10:40 --title <title>
codebank mine [--roots a,b] [--json]
codebank inbox list | accept <id> | dismiss <id>
codebank propose --title <title> --intent <intent> --files a.ts
codebank list
codebank retire <slug>
codebank doctor [--purge-usage]
codebank mcp
codebank skill install --target claude|copilot|agents [--agents-md]`);
}

if (process.argv[1]?.endsWith(`${path.sep}cli.js`)) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
