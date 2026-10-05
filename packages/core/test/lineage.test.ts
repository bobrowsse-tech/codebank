import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureHome,
  findUpdates,
  loadConfig,
  myersDiff,
  noteLocalEdit,
  parseMarkers,
  planInsert,
  planUpdate,
  promoteEntry,
  readEntry,
  readVersionFiles,
  saveConfig,
  saveEntry,
  markDrift,
  updateReplacement,
  upsertLink,
} from "../src/index";

const origin = {
  repoId: "a".repeat(40),
  repoName: "fixtures",
  relPath: "src/filter.ts",
  range: { startLine: 1, endLine: 4 },
  capturedBy: "manual" as const,
};

test("markers parse every comment form and external mode adds none", async () => {
  const samples = [
    "// @codebank filtering v1 abcdef012345",
    "# @codebank filtering v2 abcdef012345",
    "/* @codebank filtering v3 abcdef012345 */",
    "<!-- @codebank filtering v4 abcdef012345 -->",
  ];
  assert.deepEqual(
    samples.map((line) => parseMarkers(line)[0]?.version),
    [1, 2, 3, 4],
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-lineage-mode-"));
  ensureHome(home);
  const config = loadConfig(home);
  config.lineage.mode = "external";
  saveConfig(home, config);
  const saved = await saveSample(home);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const plan = planInsert({
    entry: saved.entry,
    files: [{ relPath: "src/filter.ts", content: "export function filterRows() { return []; }\n" }],
    mode: "add",
    targetLanguage: "ts",
    lineage: "external",
  });
  assert.equal(plan.files[0]?.content.includes("@codebank"), false);
});

test("a fast-forward is one replacement and a conflict is not applied", () => {
  const base = "export function filterRows() { return []; }\n";
  const same = myersDiff(base.split("\n"), base.split("\n"));
  assert.equal(same.every((edit) => edit.op === "equal"), true);
  const changed = myersDiff(["a", "b"], ["a", "c"]);
  assert.deepEqual(
    changed.map((edit) => edit.op),
    ["equal", "delete", "insert"],
  );
  const forward = planUpdate(base, base, "export function filterRows() { return [1]; }\n");
  assert.equal(forward.kind, "fast-forward");
  if (forward.kind !== "fast-forward") return;
  const local = `// @codebank filtering v1 ${"a".repeat(12)}\n${base}`;
  const replacement = updateReplacement(local, forward.result, "ts", "filtering", 2, "b".repeat(12));
  const applied = local.slice(0, replacement.start) + replacement.text + local.slice(replacement.end);
  assert.match(applied, /v2/);
  assert.match(applied, /return \[1\]/);
  const conflict = planUpdate(base, "export function filterRows() { return [2]; }\n", "export function filterRows() { return [1]; }\n");
  assert.equal(conflict.kind, "conflict");
  assert.equal("result" in conflict, false);
});

test("two copies see an update, and promoting one makes the other update", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-lineage-"));
  ensureHome(home);
  const saved = await saveSample(home);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const alpha = "a".repeat(40);
  const beta = "b".repeat(40);
  const body = "export function filterRows() { return []; }\n";
  const marked = `// @codebank filtering v1 ${saved.entry.contentHash}\n${body}`;
  await upsertLink(home, link(alpha, saved.entry.contentHash, 1));
  await upsertLink(home, link(beta, saved.entry.contentHash, 1));
  const promoted = await promoteEntry(home, "filtering", [{ relPath: "src/filter.ts", content: "export function filterRows() { return [1]; }\n" }], {
    repoId: alpha,
    relPath: "src/codebank/filtering/src/filter.ts",
  });
  assert.equal(promoted.ok, true);
  if (!promoted.ok) return;
  assert.equal(promoted.entry.version, 2);
  assert.match(readVersionFiles(home, "filtering", 1)[0]?.content ?? "", /return \[\]/);
  const current = `// @codebank filtering v2 ${promoted.entry.contentHash}\nexport function filterRows() { return [1]; }\n`;
  const alphaUpdates = findUpdates(home, alpha, [{ relPath: "src/codebank/filtering/src/filter.ts", content: current }]);
  const betaUpdates = findUpdates(home, beta, [{ relPath: "src/codebank/filtering/src/filter.ts", content: marked }]);
  assert.equal(alphaUpdates.length, 0);
  assert.equal(betaUpdates.length, 1);
  assert.equal(betaUpdates[0]?.toVersion, 2);
  const edited = await noteLocalEdit(home, beta, "src/codebank/filtering/src/filter.ts", `${marked}export const extra = 1;\n`);
  assert.equal(edited.prompt, true);
  const again = await noteLocalEdit(home, beta, "src/codebank/filtering/src/filter.ts", `${marked}export const extra = 1;\n`);
  assert.equal(again.prompt, false);
});

test("drift marks an entry stale after two repos move a dependency major", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-drift-"));
  ensureHome(home);
  const saved = await saveSample(home, [{ name: "lodash", range: "^4.17.21" }]);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const repos = ["c", "d"].map((name) => {
    const repoId = name.repeat(40);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-drift-repo-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "^5.0.0" } }));
    return { repoId, packageJson: path.join(dir, "package.json") };
  });
  await upsertLink(home, link(repos[0].repoId, saved.entry.contentHash, 1));
  await upsertLink(home, link(repos[1].repoId, saved.entry.contentHash, 1));
  const stale = await markDrift(home, repos);
  assert.deepEqual(stale, ["filtering"]);
  assert.equal(readEntry(home, "filtering")?.status, "stale");
  assert.equal(readEntry(home, "filtering")?.staleReason, "lodash");
});

async function saveSample(home: string, deps: { name: string; range: string }[] = []) {
  const content = "export function filterRows() { return []; }\n";
  return saveEntry(home, {
    slug: "filtering",
    title: "filtering",
    language: "ts",
    entryFile: "src/filter.ts",
    symbols: ["filterRows"],
    tags: ["rows"],
    intent: "Filters rows.",
    deps,
    origin,
    ownership: "personal",
  }, [{ relPath: "src/filter.ts", content }]);
}

function link(repoId: string, hash: string, version: number) {
  return {
    slug: "filtering",
    version,
    baseHash: hash,
    repoId,
    relPath: "src/codebank/filtering/src/filter.ts",
    mode: "marker" as const,
    localHash: hash,
    insertedAt: new Date().toISOString(),
  };
}
