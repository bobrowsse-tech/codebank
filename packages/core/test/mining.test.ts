import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acceptCandidate,
  dismissCandidate,
  ensureHome,
  isPackageDep,
  listCandidates,
  listEntries,
  loadConfig,
  mine,
  noteDismissed,
  noteShown,
  pastedText,
  proposeCandidate,
  readUsage,
  saveConfig,
  saveEntry,
  suggestRecall,
} from "../src/index";
import { withRequiredImports } from "../src/closure/extract";
import { inCooldown } from "../src/recall/state";
import { extractUnits } from "../src/mining/units";

test("mining finds the planted clone and no false cluster", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-mine-"));
  ensureHome(home);
  const roots = ["alpha", "beta", "gamma"].map(copyRepo);
  const result = await mine(home, { roots });
  const candidates = listCandidates(home);
  assert.equal(candidates.length, 1, candidates.map((item) => item.draft.title).join(", "));
  assert.equal(candidates[0]?.draft.symbols[0], "filterRows");
  assert.equal(candidates[0]?.proposedBy, "mining");
  assert.ok(candidates[0]?.sources.length >= 2);
  const again = await mine(home, { roots });
  assert.equal(again.candidates.length, 0);
  assert.equal(listCandidates(home).length, 1);
  assert.ok(result.files >= 3);
});

test("an agent proposal stays in the inbox until it is accepted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-inbox-"));
  ensureHome(home);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-project-"));
  const before = fs.readdirSync(project);
  const proposed = await proposeCandidate(home, {
    title: "Format currency",
    intent: "Formats a cent amount.",
    tags: ["currency"],
    files: [{ relPath: "src/format.ts", content: "export function formatCurrency(cents: number) { return cents / 100; }\n" }],
  });
  assert.equal(proposed.ok, true);
  assert.equal(listEntries(home).length, 0);
  assert.deepEqual(fs.readdirSync(project), before);
  if (!proposed.ok) return;
  assert.equal(proposed.candidate.proposedBy, "agent");
  assert.equal(proposed.candidate.draft.symbols[0], "formatCurrency");
  const unnamed = await proposeCandidate(home, {
    title: "No export",
    intent: "Missing a name.",
    tags: [],
    files: [{ relPath: "src/plain.ts", content: "const value = 1;\n" }],
  });
  assert.equal(unnamed.ok, false);
  const fallback = await proposeCandidate(home, {
    title: "Default only",
    intent: "A default export.",
    tags: [],
    files: [{ relPath: "src/fallback.ts", content: "export default function Foo() { return 1; }\n" }],
  });
  assert.equal(fallback.ok, false);
  const injected = await proposeCandidate(home, {
    title: "Bad range",
    intent: "Unsafe dependency.",
    tags: [],
    files: [{ relPath: "src/format.ts", content: "export function formatCurrency() { return 1; }\n" }],
    deps: [{ name: "lodash", range: "^1; touch /tmp/owned" }],
  });
  assert.equal(injected.ok, false);
  const blocked = await proposeCandidate(home, {
    title: "Leaked",
    intent: "nope",
    tags: [],
    files: [{ relPath: "src/secret.ts", content: 'export const apiKey = "AKIAIOSFODNN7EXAMPLE";\n' }],
  });
  assert.equal(blocked.ok, false);
  const accepted = await acceptCandidate(home, proposed.candidate.id);
  assert.equal(accepted.ok, true);
  assert.equal(listCandidates(home).some((item) => item.id === proposed.candidate.id), false);
  assert.equal(listEntries(home)[0]?.slug, "format-currency");
  const victim = path.join(home, "victim.json");
  fs.writeFileSync(victim, "{}");
  assert.equal(await dismissCandidate(home, "../../victim"), false);
  assert.equal(fs.existsSync(victim), true);
});

test("dismiss keeps a cluster out of the next scan", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-dismiss-"));
  ensureHome(home);
  const roots = ["alpha", "beta", "gamma"].map(copyRepo);
  await mine(home, { roots });
  const id = listCandidates(home)[0]?.id;
  assert.ok(id);
  assert.equal(await dismissCandidate(home, id), true);
  await mine(home, { roots });
  assert.equal(listCandidates(home).length, 0);
});

test("an empty useFilters file suggests the filtering entry and unrelated names do not", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-recall-"));
  ensureHome(home);
  await saveEntry(
    home,
    {
      slug: "filtering",
      title: "filtering",
      language: "ts",
      entryFile: "src/filterRows.ts",
      symbols: ["filterRows"],
      tags: ["filtering"],
      intent: "Filters table rows by text.",
      deps: [],
      origin: {
        repoId: "fixture",
        repoName: "fixture",
        relPath: "src/filterRows.ts",
        range: { startLine: 1, endLine: 8 },
        capturedBy: "manual",
      },
      ownership: "personal",
    },
    [{ relPath: "src/filterRows.ts", content: "export function filterRows() { return []; }\n" }],
  );
  const suggestion = suggestRecall(home, { filePath: "src/useFilters.ts", text: "", repoId: "repo", targetOrg: "fixture" });
  assert.equal(suggestion?.slug, "filtering");
  assert.equal(suggestRecall(home, { filePath: "src/useFilters.ts", text: "", repoId: "repo", enabled: false }), undefined);
  assert.equal(await noteShown(home, "repo", "src/useFilters.ts", "filtering"), true);
  assert.equal(await noteShown(home, "repo", "src/useFilters.ts", "filtering"), false);
  await noteDismissed(home, "repo", "filtering", "src/useFilters.ts");
  assert.deepEqual(
    readUsage(home).map((event) => event.kind),
    ["shown", "dismissed"],
  );
  const pasted = Array.from({ length: 12 }, () => "export const rows = 1;").join("\n");
  assert.equal(pastedText([pasted]), pasted);
  assert.equal(pastedText(["export const rows = 1;"]), undefined);
  const started = Date.now();
  for (let minute = 0; minute < 30; minute += 1) {
    const unrelated = suggestRecall(home, {
      filePath: `src/quarterlyReport${minute}.ts`,
      text: "export const value = 1;\n",
      repoId: "repo",
      now: started + minute * 60_000,
    });
    assert.equal(unrelated, undefined);
  }
});

test("a regex brace does not truncate a unit, and ignored paths are not scanned", async () => {
  const source = [
    "export function keepPattern(rows: string[]) {",
    "  const closed = /}/;",
    "  const opened = /{/;",
    "  const ratio = rows.length / 2;",
    "  const extra = rows.length + 1;",
    "  const more = rows.length + 2;",
    "  return rows.filter((row) => closed.test(row) && opened.test(row) && ratio > 0 && extra > more);",
    "}",
  ].join("\n");
  const units = extractUnits(source);
  assert.equal(units.length, 1);
  assert.match(units[0].content, /return rows/);
  const expression = extractUnits(padded("parseRows", 8).replace("export function parseRows", "export const parseRows = function"));
  assert.equal(expression[0]?.name, "parseRows");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-ignore-"));
  ensureHome(home);
  const config = loadConfig(home);
  config.scan.ignore = [...config.scan.ignore, "skipme"];
  saveConfig(home, config);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-ignore-repo-"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, "skipme"));
  fs.writeFileSync(path.join(repo, "src", "keep.jsx"), padded("keepRows", 20));
  fs.writeFileSync(path.join(repo, "src", "keep.test.jsx"), "test('keep', () => {});\n");
  fs.writeFileSync(path.join(repo, "skipme", "hide.ts"), padded("hideRows", 20));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  const result = await mine(home, { roots: [repo] });
  assert.equal(result.files, 1);
  assert.equal(listCandidates(home).some((item) => item.draft.symbols[0] === "keepRows"), true);

  const controller = new AbortController();
  const cancelledHome = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-cancel-"));
  ensureHome(cancelledHome);
  const cancelled = await mine(cancelledHome, {
    roots: [repo],
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(listCandidates(cancelledHome).length, 0);
});

test("a mined unit keeps the imports it uses", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-import-home-"));
  ensureHome(home);
  const source = `import { rows } from "./rows";\n${padded("filterItems", 8).replace("return rows;", "return rows();")}`;
  const files = { "src/rows.ts": "export function rows() { return []; }\n", "src/filter.ts": source };
  await mine(home, { roots: [repoWith(files), repoWith(files)] });
  const candidate = listCandidates(home).find((item) => item.draft.symbols[0] === "filterItems");
  assert.ok(candidate);
  assert.match(candidate.files[0]?.content ?? "", /import \{ rows \} from "\.\/rows"/);
  assert.match(candidate.files[0]?.content ?? "", /return rows\(\)/);
  const body = "export function greet(user: User) {\n  return user;\n}\n";
  assert.match(withRequiredImports(`import { type User } from "./types";\n${body}`, body), /import \{ type User \} from "\.\/types"/);
  assert.match(withRequiredImports(`import type User from "./types";\n${body}`, body), /import type User from "\.\/types"/);
  assert.equal(isPackageDep({ name: "typescript", range: "^18" }), true);
  assert.equal(isPackageDep({ name: "lodash", range: "~1.2" }), true);
  assert.equal(isPackageDep({ name: "lodash", range: "1.x" }), true);
  assert.equal(isPackageDep({ name: "lodash", range: "^1; touch /tmp/x" }), false);
});

test("a root generated directory is not scanned", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-generated-"));
  ensureHome(home);
  const config = loadConfig(home);
  config.recall.cooldownMinutes = 1;
  saveConfig(home, config);
  await noteDismissed(home, "repo", "filtering", "src/useFilters.ts");
  assert.equal(inCooldown(home, "repo", "src/useFilters.ts"), true);
  assert.equal(inCooldown(home, "repo", "src/useFilters.ts", Date.now() + 2 * 60_000), false);
  const repo = repoWith({
    "generated/client.ts": padded("clientRows", 12),
    "src/keep.ts": padded("keepLocal", 12),
  });
  const result = await mine(home, { roots: [repo] });
  assert.equal(result.files, 1);
  const blank = await proposeCandidate(home, {
    title: " ",
    intent: "Missing a title.",
    tags: [" "],
    files: [{ relPath: "src/blank.ts", content: "export function blank() { return 1; }\n" }],
  });
  assert.equal(blank.ok, false);
});

test("a tracked symlink is not read", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-link-home-"));
  ensureHome(home);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-outside-"));
  const outsideFile = path.join(outside, "secret.ts");
  fs.writeFileSync(outsideFile, padded("outsideRows", 12));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-link-repo-"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "local.ts"), padded("localRows", 12));
  fs.symlinkSync(outsideFile, path.join(repo, "src", "linked.ts"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  const result = await mine(home, { roots: [repo] });
  assert.equal(result.files, 1);
  assert.equal(JSON.stringify(listCandidates(home)).includes("outsideRows"), false);
});

test("secrets and private functions stay out of the inbox", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-secret-mine-"));
  ensureHome(home);
  const secret = padded("leakRows", 8).replace("return rows;", 'const key = "AKIAIOSFODNN7EXAMPLE";\n  return rows;');
  const leaked = [secret, secret].map((content) => repoWith({ "src/leak.ts": content }));
  await mine(home, { roots: leaked });
  assert.equal(listCandidates(home).length, 0);

  const hiddenHome = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-private-mine-"));
  ensureHome(hiddenHome);
  const hidden = padded("sharedRows", 12).replace("export function", "function");
  await mine(hiddenHome, { roots: [hidden, hidden].map((content) => repoWith({ "src/shared.ts": content })) });
  assert.equal(listCandidates(hiddenHome).length, 0);
});

function repoWith(files: Record<string, string>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-unit-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function padded(name: string, lines: number): string {
  const body = [`export function ${name}(rows: string[]) {`];
  while (body.length < lines - 1) body.push(`  const v${body.length} = rows.length + ${body.length};`);
  body.push("  return rows;");
  body.push("}");
  return body.join("\n");
}

function copyRepo(name: string): string {
  const from = path.join(process.cwd(), "fixtures/repos", name);
  const to = fs.mkdtempSync(path.join(os.tmpdir(), `codebank-${name}-`));
  fs.cpSync(from, to, { recursive: true });
  execFileSync("git", ["init"], { cwd: to, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: to, stdio: "ignore" });
  return to;
}
