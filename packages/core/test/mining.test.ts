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
  mine,
  noteDismissed,
  noteShown,
  proposeCandidate,
  readUsage,
  saveEntry,
  suggestRecall,
} from "../src/index";

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

function copyRepo(name: string): string {
  const from = path.join(process.cwd(), "fixtures/repos", name);
  const to = fs.mkdtempSync(path.join(os.tmpdir(), `codebank-${name}-`));
  fs.cpSync(from, to, { recursive: true });
  execFileSync("git", ["init"], { cwd: to, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: to, stdio: "ignore" });
  return to;
}
