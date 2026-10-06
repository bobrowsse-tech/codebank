import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const core = await import(pathToFileURL(path.join(root, "packages/core/dist/index.js")).href);
const stages = [];
core.setLogger((stage, direction, data) => {
  stages.push(stage);
  console.error(`debug ${stage} ${direction} ${JSON.stringify(data)}`);
});

const done = [];
const created = [];
const home = tempDir("codebank-bash-");
const alpha = tempDir("codebank-bash-alpha-");
const beta = tempDir("codebank-bash-beta-");
const alphaRepo = "a".repeat(40);
const betaRepo = "b".repeat(40);
let failed;

try {
  core.ensureHome(home);
  const closure = core.heuristicClosure(path.join(root, "fixtures/workspace/src/filterRows.ts"));
  const deposited = await core.saveEntry(
    home,
    {
      slug: "filtering",
      title: "filtering",
      language: closure.language,
      entryFile: closure.entryFile,
      symbols: closure.symbols,
      tags: ["filtering"],
      intent: "Filters table rows by text.",
      deps: closure.deps,
      origin: {
        repoId: "c".repeat(40),
        repoName: "fixtures",
        relPath: closure.entryFile,
        range: { startLine: 1, endLine: 8 },
        capturedBy: "manual",
      },
      ownership: "personal",
    },
    closure.files,
  );
  if (!deposited.ok) fail("deposit", deposited.reason);
  if (closure.files.length !== 3) fail("deposit", `expected 3 files, got ${closure.files.length}`);
  pass("deposit");

  const hits = core.searchBank(home, "filtering", 5);
  if (hits[0]?.slug !== "filtering") fail("search", hits.map((hit) => hit.slug).join(", ") || "no hits");
  pass("search");

  const entry = core.readEntry(home, "filtering");
  const files = core.readEntryFiles(home, "filtering");
  const plan = core.planInsert({ entry, files, mode: "add", targetLanguage: "ts", lineage: "marker" });
  if (!plan.installCommand?.startsWith("npm install")) fail("insert", "missing install command");
  const written = core.applyInsert(alpha, "src/codebank", plan);
  const betaWritten = core.applyInsert(beta, "src/codebank", plan);
  const marked = fs.readFileSync(written[0], "utf8");
  if (!marked.includes("@codebank filtering v1")) fail("insert", "marker was not written");
  if (fs.existsSync(path.join(alpha, "node_modules")) || fs.existsSync(path.join(beta, "node_modules"))) {
    fail("insert", "install command was executed");
  }
  pass("insert");

  const suggestion = core.suggestRecall(home, { filePath: "src/useFilters.ts", text: "", repoId: alphaRepo });
  if (suggestion?.slug !== "filtering") fail("recall", suggestion?.slug ?? "no suggestion");
  pass("recall");

  const roots = ["alpha", "beta", "gamma"].map(copyRepo);
  const mined = await core.mine(home, { roots });
  if (mined.candidates.length < 1) fail("scan", "no candidates");
  pass("scan");

  const candidate = core.listCandidates(home)[0];
  const before = core.listEntries(home).length;
  const projectBefore = snapshot(alpha);
  const rootsBefore = roots.map(snapshot);
  const accepted = await core.acceptCandidate(home, candidate.id);
  if (!accepted.ok) fail("inbox", accepted.reason);
  if (core.listEntries(home).length !== before + 1) fail("inbox", "accept did not create an entry");
  if (snapshot(alpha) !== projectBefore) fail("inbox", "accept wrote a project file");
  if (roots.map(snapshot).join("\n") !== rootsBefore.join("\n")) fail("inbox", "accept changed a scanned repository");
  pass("inbox");

  const proposed = await core.proposeCandidate(home, {
    title: "Format currency",
    intent: "Formats a cent amount.",
    tags: ["currency"],
    files: [{ relPath: "src/format.ts", content: "export function formatCurrency(cents: number) { return cents / 100; }\n" }],
  });
  if (!proposed.ok) fail("propose", proposed.reason);
  if (core.listEntries(home).some((item) => item.slug === proposed.candidate.draft.slug)) fail("propose", "proposal became an entry");
  if (snapshot(alpha) !== projectBefore) fail("propose", "proposal wrote a project file");
  pass("propose");

  const inserted = fs.readFileSync(written[0], "utf8");
  const betaInserted = fs.readFileSync(betaWritten[0], "utf8");
  const revised = core.readEntryFiles(home, "filtering").map((file) =>
    file.relPath === entry.entryFile ? { ...file, content: `${file.content}\nexport const bankRevision = 2;\n` } : file,
  );
  const replaced = await core.saveEntry(home, draftFrom(entry), revised, { mode: "replace" });
  if (!replaced.ok || replaced.entry.version !== 2) fail("update", replaced.ok ? `version ${replaced.entry.version}` : replaced.reason);
  const rel = relative(alpha, written[0]);
  const notices = core.findUpdates(home, alphaRepo, [{ relPath: rel, content: fs.readFileSync(written[0], "utf8") }]);
  if (!notices.some((notice) => notice.slug === "filtering" && notice.toVersion === 2)) fail("update", "no update notice");
  if (fs.readFileSync(written[0], "utf8") !== inserted) fail("update", "update was applied on its own");
  pass("update");

  const promotedFiles = revised.map((file) =>
    file.relPath === entry.entryFile ? { ...file, content: file.content.replace("bankRevision = 2", "bankRevision = 3") } : file,
  );
  const promoted = await core.promoteEntry(home, "filtering", promotedFiles);
  if (!promoted.ok || promoted.entry.version !== 3) fail("promote", promoted.ok ? `version ${promoted.entry.version}` : promoted.reason);
  const betaRel = relative(beta, betaWritten[0]);
  const betaNotices = core.findUpdates(home, betaRepo, [{ relPath: betaRel, content: fs.readFileSync(betaWritten[0], "utf8") }]);
  if (!betaNotices.some((notice) => notice.slug === "filtering" && notice.toVersion === 3)) fail("promote", "the other copy did not show an update");
  if (fs.readFileSync(betaWritten[0], "utf8") !== betaInserted) fail("promote", "the other copy was changed");
  pass("promote");

  if (!(await core.retireEntry(home, "filtering"))) fail("retire", "entry was missing");
  if (core.searchBank(home, "filtering", 5).some((card) => card.slug === "filtering")) fail("retire", "search still returns it");
  const retiredNotices = core.findUpdates(home, betaRepo, [{ relPath: betaRel, content: betaInserted }]);
  if (retiredNotices.some((notice) => notice.slug === "filtering")) fail("retire", "a retired entry still shows an update");
  pass("retire");
} catch (error) {
  failed = error;
} finally {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.error(failed instanceof Error ? failed.stack ?? failed.message : String(failed));
  process.exit(1);
}

for (const stage of ["deposit", "search", "insert", "recall", "mining", "inbox", "propose", "lineage", "retire"]) {
  if (!stages.includes(stage)) {
    console.error(`missing debug stage ${stage}`);
    process.exit(1);
  }
}
console.log("bug-bash ok");

function pass(name) {
  done.push(name);
  console.log(`ok  ${name}`);
}

function fail(name, detail) {
  throw new Error(`FAIL  ${name} — ${detail}`);
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function copyRepo(name) {
  const from = path.join(root, "fixtures/repos", name);
  const to = tempDir(`codebank-bash-${name}-`);
  fs.cpSync(from, to, { recursive: true });
  execFileSync("git", ["init"], { cwd: to, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: to, stdio: "ignore" });
  return to;
}

function snapshot(dir) {
  return walk(dir, dir).sort().join("\n");
}

function walk(dir, base) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    if (name === ".git") return [];
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return walk(full, base);
    const rel = path.relative(base, full).split(path.sep).join("/");
    return [`${rel}\t${fs.readFileSync(full, "utf8")}`];
  });
}

function relative(dir, file) {
  return path.relative(dir, file).split(path.sep).join("/");
}

function draftFrom(entry) {
  return {
    slug: entry.slug,
    title: entry.title,
    language: entry.language,
    entryFile: entry.entryFile,
    symbols: entry.symbols,
    tags: entry.tags,
    intent: entry.intent,
    whenNot: entry.whenNot,
    deps: entry.deps,
    origin: entry.origin,
    ownership: entry.ownership,
  };
}
