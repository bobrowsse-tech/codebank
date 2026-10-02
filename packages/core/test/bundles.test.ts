import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("bundles do not import a network module", () => {
  const roots = ["packages/core/dist", "packages/cli/dist", "packages/vscode/dist"].filter((dir) => fs.existsSync(dir));
  assert.ok(roots.length > 0, "build the packages before this test");
  const pattern = /from ['"]node:(http|https|net)['"]|from ['"](http|https|net)['"]|require\(['"]node:(http|https|net)['"]\)|\bfetch\(/;
  for (const root of roots) {
    for (const file of walk(root)) {
      if (!file.endsWith(".js")) continue;
      const source = fs.readFileSync(file, "utf8");
      assert.equal(pattern.test(source), false, `${path.relative(process.cwd(), file)} imports the network`);
    }
  }
});

test("core source does not import vscode", () => {
  const root = path.join(process.cwd(), "packages/core/src");
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(/from ['"]vscode['"]/.test(source), false, file);
  }
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  });
}
