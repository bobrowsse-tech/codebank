import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureHome, mine } from "../src/index";

test("a scan of 20 repos and 50000 files finishes within 60 seconds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-scale-"));
  const repos: string[] = [];
  for (let repo = 0; repo < 20; repo += 1) {
    const dir = path.join(root, `repo-${repo}`);
    fs.mkdirSync(dir);
    const count = repo === 0 ? 49_981 : 1;
    for (let file = 0; file < count; file += 1) {
      fs.writeFileSync(path.join(dir, `f${file}.ts`), uniqueUnit(repo, file));
    }
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    repos.push(dir);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-scale-home-"));
  ensureHome(home);
  const result = await mine(home, { roots: repos });
  console.log(`scale scan ${result.files} files ${result.repos} repos ${Math.round(result.elapsedMs)} ms on ${result.machine}`);
  assert.equal(result.files, 50_000);
  assert.equal(result.repos, 20);
  assert.ok(result.elapsedMs < 60_000, `scan took ${result.elapsedMs} ms on ${result.machine}`);
});

function uniqueUnit(repo: number, file: number): string {
  const id = `r${repo}f${file}`;
  return `export function ${id}(value: string): string {\n  const ${id}Label = value.trim();\n  const ${id}Lower = ${id}Label.toLowerCase();\n  if (${id}Lower.length === 0) {\n    return ${id}Label;\n  }\n  const ${id}Body = ${id}Lower;\n  return ${id}Body;\n}\n`;
}
