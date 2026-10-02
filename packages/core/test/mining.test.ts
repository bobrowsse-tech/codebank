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
  listCandidates,
  listEntries,
  loadConfig,
  mine,
  noteDismissed,
  noteShown,
  proposeCandidate,
  readUsage,
  saveConfig,
  saveEntry,
  suggestRecall,
} from "../src/index";
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
  const proposed = proposeCandidate(home, {
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
  const blocked = proposeCandidate(home, {
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
  assert.equal(dismissCandidate(home, "../../victim"), false);
  assert.equal(fs.existsSync(victim), true);
});

test("dismiss keeps a cluster out of the next scan", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-dismiss-"));
  ensureHome(home);
  const roots = ["alpha", "beta", "gamma"].map(copyRepo);
  await mine(home, { roots });
  const id = listCandidates(home)[0]?.id;
  assert.ok(id);
  assert.equal(dismissCandidate(home, id), true);
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
  assert.equal(noteShown(home, "repo", "src/useFilters.ts", "filtering"), true);
  assert.equal(noteShown(home, "repo", "src/useFilters.ts", "filtering"), false);
  noteDismissed(home, "repo", "filtering", "src/useFilters.ts");
  assert.deepEqual(
    readUsage(home).map((event) => event.kind),
    ["shown", "dismissed"],
  );
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
