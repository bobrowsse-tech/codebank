import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureHome,
  findUpdates,
  lineageMode,
  linkedContentHash,
  listAllLinks,
  loadConfig,
  markerBody,
  myersDiff,
  noteLocalEdit,
  parseMarkers,
  planInsert,
  planUpdate,
  promoteEntry,
  readEntry,
  readEntryFiles,
  readLinks,
  readVersionFiles,
  rememberedRepos,
  rememberRepo,
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
  assert.equal(lineageMode(config, "unknown"), "marker");
  assert.equal(lineageMode(config, "personal"), "marker");
  assert.equal(lineageMode(config, "client"), "external");
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
  const html = planInsert({
    entry: { ...saved.entry, language: "other", entryFile: "page.html" },
    files: [{ relPath: "page.html", content: "<p>Hi</p>\n" }],
    mode: "add",
    targetLanguage: "other",
  });
  assert.match(html.files[0]?.content ?? "", /^<!-- @codebank filtering v1 /);
  assert.equal(parseMarkers(html.files[0]?.content ?? "")[0]?.slug, "filtering");
  const mixed = planInsert({
    entry: saved.entry,
    files: [
      { relPath: "src/filter.ts", content: "export function filterRows() { return []; }\n" },
      { relPath: "src/filter.css", content: ".row { }\n" },
    ],
    mode: "add",
    targetLanguage: "ts",
  });
  assert.match(mixed.files[0]?.content ?? "", /^\/\/ @codebank /);
  assert.match(mixed.files[1]?.content ?? "", /^\/\* @codebank /);
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
  const surrounded = `const keep = 1;\n// @codebank filtering v1 ${"a".repeat(12)}\n${base}// @codebank-end\nconst after = 2;\n`;
  assert.equal(markerBody(surrounded, "filtering"), base);
  assert.equal(planUpdate(base, markerBody(surrounded, "filtering") ?? "", "export function filterRows() { return [1]; }\n").kind, "fast-forward");
  const local = `// @codebank filtering v1 ${"a".repeat(12)}\n${base}`;
  const replacement = updateReplacement(local, forward.result, "ts", "filtering", 2, "b".repeat(12));
  const applied = local.slice(0, replacement.start) + replacement.text + local.slice(replacement.end);
  assert.match(applied, /v2/);
  assert.match(applied, /return \[1\]/);
  const htmlLocal = `<!-- @codebank filtering v1 ${"a".repeat(12)} -->\n<p>Hi</p>\n`;
  const htmlReplacement = updateReplacement(htmlLocal, "<p>Bye</p>\n", "other", "filtering", 2, "b".repeat(12), "page.html");
  assert.match(htmlReplacement.text, /^<!-- @codebank filtering v2 /);
  const wrapped = `const keep = 1;\n// @codebank filtering v1 ${"a".repeat(12)}\n${base}// @codebank-end\nconst after = 2;\n`;
  const next = "export function filterRows() { return [1]; }\n";
  const replaced = updateReplacement(wrapped, next, "ts", "filtering", 2, "b".repeat(12));
  const appliedWrapped = wrapped.slice(0, replaced.start) + replaced.text + wrapped.slice(replaced.end);
  assert.match(appliedWrapped, /return \[1\]; \}\n\/\/ @codebank-end\nconst after = 2;/);
  assert.equal(appliedWrapped.includes("\n\n// @codebank-end"), false);
  const literal = `// @codebank filtering v1 ${"a".repeat(12)}\nconst label = "@codebank-end";\n${base}// @codebank-end\n`;
  assert.match(markerBody(literal, "filtering") ?? "", /const label = "@codebank-end"/);
  const embedded = `before();\n${base}after();\n`;
  const only = updateReplacement(embedded, next, "ts", "filtering", 2, "b".repeat(12), undefined, base);
  assert.equal(embedded.slice(0, only.start) + only.text + embedded.slice(only.end), `before();\n${next}after();\n`);
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
  const quietHash = linkedContentHash("src/filter.ts", body);
  await upsertLink(home, { ...link(beta, quietHash, 1), localHash: quietHash, sourceRelPath: "src/filter.ts" });
  const outside = `const keep = 1;\n${marked}// @codebank-end\nconst after = 2;\n`;
  const quiet = await noteLocalEdit(home, beta, "src/codebank/filtering/src/filter.ts", outside);
  assert.equal(quiet.prompt, false);
  const hostHash = linkedContentHash("src/filter.ts", body);
  await upsertLink(home, { ...link(beta, hostHash, 1), localHash: hostHash, sourceRelPath: "src/filter.ts", mode: "external" });
  const host = `before();\n${body}after();\n`;
  const untouched = await noteLocalEdit(home, beta, "src/codebank/filtering/src/filter.ts", host);
  assert.equal(untouched.prompt, false);
});

test("promoting a helper replaces that file and archives it atomically", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-lineage-helper-"));
  ensureHome(home);
  const entryFile = "export function filterRows() { return []; }\n";
  const helper = "export const helper = 1;\n";
  const saved = await saveEntry(home, {
    slug: "filtering",
    title: "filtering",
    language: "ts",
    entryFile: "src/filter.ts",
    symbols: ["filterRows"],
    tags: ["rows"],
    intent: "Filters rows.",
    deps: [],
    origin,
    ownership: "personal",
  }, [
    { relPath: "src/filter.ts", content: entryFile },
    { relPath: "src/helper.ts", content: helper },
  ]);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const nextHelper = "export const helper = 2;\n";
  const promoted = await promoteEntry(home, "filtering", [
    { relPath: "src/filter.ts", content: entryFile },
    { relPath: "src/helper.ts", content: nextHelper },
  ], {
    repoId: "a".repeat(40),
    relPath: "src/codebank/filtering/src/helper.ts",
    sourceRelPath: "src/helper.ts",
  });
  assert.equal(promoted.ok, true);
  const files = readEntryFiles(home, "filtering");
  assert.equal(files.find((file) => file.relPath === "src/filter.ts")?.content, entryFile);
  assert.equal(files.find((file) => file.relPath === "src/helper.ts")?.content, nextHelper);
  assert.equal(readVersionFiles(home, "filtering", 1).find((file) => file.relPath === "src/helper.ts")?.content, helper);
  assert.equal(readLinks(home, "a".repeat(40))[0]?.sourceRelPath, "src/helper.ts");
  assert.equal(readLinks(home, "a".repeat(40))[0]?.baseHash, linkedContentHash("src/helper.ts", nextHelper));
  const archived = fs.readdirSync(path.join(home, "entries", "filtering", "versions", "1"), { recursive: true }).map(String);
  assert.equal(archived.some((name) => name.includes(".tmp")), false);
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
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-drift-broken-"));
  fs.writeFileSync(path.join(broken, "package.json"), "{");
  const stale = await markDrift(home, [...repos, { repoId: "e".repeat(40), packageJson: path.join(broken, "package.json") }]);
  assert.deepEqual(stale, ["filtering"]);
  assert.equal(readEntry(home, "filtering")?.status, "stale");
  assert.equal(readEntry(home, "filtering")?.staleReason, "lodash");
  const notices = findUpdates(home, repos[0].repoId, []);
  assert.equal(notices[0]?.kind, "stale");
  assert.equal(notices[0]?.staleReason, "lodash");
  await rememberRepo(home, repos[0].repoId, path.dirname(repos[0].packageJson));
  await rememberRepo(home, repos[1].repoId, path.dirname(repos[1].packageJson));
  assert.equal(rememberedRepos(home).length, 2);
  assert.equal(listAllLinks(home).length, 2);
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
