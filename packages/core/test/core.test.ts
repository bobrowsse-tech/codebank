import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SchemaError,
  applyInsert,
  ensureHome,
  heuristicClosure,
  planInsert,
  readEntry,
  readEntryFiles,
  resolveOwnership,
  saveEntry,
  scanSecrets,
  searchBank,
  toSlug,
  withLock,
} from "../src/index";
import { atomicWriteJson } from "../src/store/atomic";
import { bankPaths } from "../src/store/paths";

const workspace = path.join(process.cwd(), "fixtures/workspace/src/filterRows.ts");
const secretFile = path.join(process.cwd(), "fixtures/secret/sample.ts");

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codebank-"));
}

test("closure of the fixture keeps two helpers and the lodash range", () => {
  const closure = heuristicClosure(workspace);
  assert.equal(closure.files.length, 3);
  assert.deepEqual(
    closure.files.map((file) => file.relPath).sort(),
    ["src/filterRows.ts", "src/match.ts", "src/normalize.ts"],
  );
  assert.deepEqual(closure.deps, [{ name: "lodash", range: "^4.17.21" }]);
  assert.ok(closure.symbols.includes("filterRows"));
});

test("a fake secret cannot be saved", async () => {
  const home = tempHome();
  ensureHome(home);
  const content = fs.readFileSync(secretFile, "utf8");
  const outcome = await saveEntry(
    home,
    {
      slug: "leaked",
      title: "leaked",
      language: "ts",
      entryFile: "sample.ts",
      symbols: ["apiKey"],
      tags: ["secret"],
      intent: "Holds a key.",
      deps: [],
      origin: origin("sample.ts"),
      ownership: "personal",
    },
    [{ relPath: "sample.ts", content }],
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "secrets");
  assert.equal(fs.existsSync(path.join(home, "entries", "leaked")), false);
});

test("secrets scanner accepts ordinary code and flags the spec patterns", () => {
  assert.equal(scanSecrets("export function add(a: number, b: number) { return a + b; }").filter((f) => f.severity === "block").length, 0);
  assert.ok(scanSecrets('const password = "hunter22";').some((f) => f.kind === "assigned-secret"));
  assert.ok(scanSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc").some((f) => f.kind === "private-key"));
  assert.ok(scanSecrets("https://user:secretpass@example.com").some((f) => f.kind === "url-credential"));
  assert.ok(scanSecrets("fetch('http://intranet.corp/api')").some((f) => f.severity === "warn"));
});

test("ownership follows the configured orgs", () => {
  const config = ensureHome(tempHome());
  config.orgs.personal = ["bobrowsse-tech"];
  config.orgs.client = ["example-client-org"];
  assert.equal(resolveOwnership("bobrowsse-tech", config), "personal");
  assert.equal(resolveOwnership("example-client-org", config), "client");
  assert.equal(resolveOwnership(undefined, config), "unknown");
});

test("search ranks filtering first and stays under 50 ms after warm-up", async () => {
  const home = tempHome();
  ensureHome(home);
  const closure = heuristicClosure(workspace);
  const saved = await saveEntry(home, draftFromClosure(closure), closure.files);
  assert.equal(saved.ok, true);
  for (let i = 0; i < 19; i += 1) {
    await saveEntry(
      home,
      {
        slug: `note-${i}`,
        title: `note ${i}`,
        language: "ts",
        entryFile: "note.ts",
        symbols: [`note${i}`],
        tags: ["note"],
        intent: "A different helper.",
        deps: [],
        origin: origin("note.ts"),
        ownership: "personal",
      },
      [{ relPath: "note.ts", content: `export const note${i} = ${i};\n` }],
    );
  }
  const top = searchBank(home, "filtering", 8);
  assert.equal(top[0]?.slug, "filtering");

  const perfHome = tempHome();
  ensureHome(perfHome);
  for (let i = 0; i < 500; i += 1) {
    const slug = `gen-${i}`;
    const dir = path.join(bankPaths(perfHome).entries, slug);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteJson(path.join(dir, "entry.json"), {
      schema: 1,
      slug,
      title: i === 0 ? "filtering rows" : `generated ${i}`,
      version: 1,
      contentHash: "abcdef123456",
      language: "ts",
      entryFile: "gen.ts",
      symbols: [i === 0 ? "filterRows" : `gen${i}`],
      tags: [i === 0 ? "filtering" : "generated"],
      intent: i === 0 ? "Filters table rows." : "Generated filler.",
      deps: [],
      origin: origin("gen.ts"),
      ownership: "personal",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { uses: 0, verbatimInserts: 0 },
      status: "active",
    });
  }
  searchBank(perfHome, "filtering", 8);
  const started = performance.now();
  const ranked = searchBank(perfHome, "filtering", 8);
  const elapsed = performance.now() - started;
  assert.equal(ranked[0]?.title, "filtering rows");
  assert.ok(elapsed < 50, `search took ${elapsed} ms`);
});

test("insert writes a marker only when apply is called, and does not run install", async () => {
  const home = tempHome();
  ensureHome(home);
  const closure = heuristicClosure(workspace);
  const saved = await saveEntry(home, draftFromClosure(closure), closure.files);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-project-"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "target", dependencies: {} }));
  const before = fs.readdirSync(project);
  const plan = planInsert({
    entry: saved.entry,
    files: closure.files,
    mode: "add",
    targetLanguage: "ts",
    targetPackageJson: path.join(project, "package.json"),
    targetOrg: "bobrowsse-tech",
  });
  assert.deepEqual(fs.readdirSync(project), before);
  assert.match(plan.installCommand ?? "", /^npm install lodash@/);
  const written = applyInsert(project, "src/codebank", plan);
  const marked = fs.readFileSync(written[0], "utf8");
  assert.match(marked.split("\n")[0], /^\/\/ @codebank filtering v1 [a-f0-9]{12}$/);
  assert.equal(fs.existsSync(path.join(project, "node_modules", "lodash")), false);
});

test("a newer schema is refused", () => {
  const home = tempHome();
  ensureHome(home);
  const slug = "future";
  const dir = path.join(bankPaths(home).entries, slug);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(path.join(dir, "entry.json"), { schema: 2 });
  assert.throws(() => readEntry(home, slug), SchemaError);
});

test("the lock is exclusive and a stale lock is removed", async () => {
  const home = tempHome();
  ensureHome(home);
  const lock = bankPaths(home).lock;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withLock(lock, () => held);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const secondStarted = Date.now();
  const second = withLock(lock, () => "second");
  release();
  assert.equal(await second, "second");
  await first;
  assert.ok(Date.now() - secondStarted < 5_000);
  fs.writeFileSync(lock, "old");
  const past = new Date(Date.now() - 20_000);
  fs.utimesSync(lock, past, past);
  assert.equal(await withLock(lock, () => "recovered"), "recovered");
});

test("a ranged deposit keeps the selection and still follows imports above it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-range-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { lodash: "^4.17.21" } }));
  fs.writeFileSync(
    path.join(root, "src", "kept.ts"),
    ['import { helper } from "./helper";', 'import escape from "lodash";', "export function ignored() { return 1; }", "export function kept(text: string) { return helper(escape(text)); }", ""].join("\n"),
  );
  fs.writeFileSync(path.join(root, "src", "helper.ts"), "export function helper(value: string) { return value; }\n");
  const closure = heuristicClosure(path.join(root, "src", "kept.ts"), { startLine: 4, endLine: 4 });
  assert.ok(closure.files.some((file) => file.relPath.endsWith("helper.ts")));
  const entry = closure.files.find((file) => file.relPath.endsWith("kept.ts"));
  assert.equal(entry?.content.includes("ignored"), false);
  assert.ok(closure.deps.some((dep) => dep.name === "lodash"));
});

test("an existing slug is not overwritten, a replacement drops stale files, and a symlink outside the bank is refused", async () => {
  const home = tempHome();
  ensureHome(home);
  const first = await saveEntry(home, sampleDraft("same"), [{ relPath: "a.ts", content: "export const a = 1;\n" }, { relPath: "stale.ts", content: "export const stale = 1;\n" }]);
  assert.equal(first.ok, true);
  const collision = await saveEntry(home, sampleDraft("same"), [{ relPath: "b.ts", content: "export const b = 2;\n" }]);
  assert.equal(collision.ok, false);
  if (collision.ok) return;
  assert.equal(collision.reason, "invalid");
  assert.match(readEntryFiles(home, "same").map((file) => file.content).join("\n"), /const a/);

  const replaced = await saveEntry(home, sampleDraft("same"), [{ relPath: "a.ts", content: "export const a = 3;\n" }], { mode: "replace" });
  assert.equal(replaced.ok, true);
  assert.deepEqual(readEntryFiles(home, "same").map((file) => file.relPath), ["a.ts"]);

  const outside = path.join(os.tmpdir(), `codebank-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(home, "entries", "same", "code", "link.ts"));
  assert.throws(() => readEntryFiles(home, "same"), /escapes/);
});

test("insert stays inside the project, and a cursor insert is wrapped with an end marker", async () => {
  const home = tempHome();
  ensureHome(home);
  const closure = heuristicClosure(workspace);
  const saved = await saveEntry(home, draftFromClosure(closure), closure.files);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-project-"));
  fs.mkdirSync(path.join(project, "src"));
  const plan = planInsert({
    entry: saved.entry,
    files: closure.files,
    mode: "add",
    targetLanguage: "ts",
    fromFile: path.join(project, "src", "app.ts"),
    projectDir: project,
    insertDir: "src/codebank",
  });
  assert.match(plan.importLine ?? "", /from '\.\/codebank\/filtering\/src\/filterRows'/);
  assert.throws(() => applyInsert(project, "../outside", plan), /Rejected path|escapes/);
  const cursor = planInsert({ entry: saved.entry, files: [closure.files[0]], mode: "cursor", targetLanguage: "ts" });
  assert.match(cursor.files[0].content, /@codebank filtering v1/);
  assert.match(cursor.files[0].content, /@codebank-end/);
});

test("client entries are hidden outside their organization", async () => {
  const home = tempHome();
  ensureHome(home);
  await saveEntry(
    home,
    { ...sampleDraft("client-only"), ownership: "client", origin: { ...origin("client.ts"), org: "acme" } },
    [{ relPath: "client.ts", content: "export const clientOnly = 1;\n" }],
  );
  await saveEntry(home, sampleDraft("personal-note"), [{ relPath: "note.ts", content: "export const personalNote = 1;\n" }]);
  const elsewhere = searchBank(home, "client", 8, { targetOrg: "other" }).map((card) => card.slug);
  assert.equal(elsewhere.includes("client-only"), false);
  const homeOrg = searchBank(home, "client", 8, { targetOrg: "acme" }).map((card) => card.slug);
  assert.ok(homeOrg.includes("client-only"));
});

test("slug helper stays inside the spec pattern", () => {
  assert.equal(toSlug("Filter Rows"), "filter-rows");
  assert.match(toSlug("!!!"), /^entry$/);
});

function origin(relPath: string) {
  return {
    repoId: "fixture",
    repoName: "fixture-workspace",
    org: "bobrowsse-tech",
    relPath,
    range: { startLine: 1, endLine: 8 },
    capturedBy: "manual" as const,
  };
}

function sampleDraft(slug: string) {
  return {
    slug,
    title: slug,
    language: "ts" as const,
    entryFile: "a.ts",
    symbols: [slug],
    tags: [slug],
    intent: `Intent for ${slug}.`,
    deps: [],
    origin: origin("a.ts"),
    ownership: "personal" as const,
  };
}

function draftFromClosure(closure: ReturnType<typeof heuristicClosure>) {
  return {
    slug: "filtering",
    title: "filtering",
    language: closure.language,
    entryFile: closure.entryFile,
    symbols: closure.symbols,
    tags: ["filtering", "table"],
    intent: "Filters table rows by text.",
    deps: closure.deps,
    origin: origin(closure.entryFile),
    ownership: "personal" as const,
  };
}
