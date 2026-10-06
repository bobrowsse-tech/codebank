import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

fs.rmSync("dist-tests", { recursive: true, force: true });
const entryPoints = walk("packages").filter((file) => file.endsWith(".test.ts"));
await build({
  entryPoints,
  outdir: "dist-tests",
  outbase: ".",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

const files = walk("dist-tests").filter((file) => file.endsWith(".test.js"));
const result = spawnSync(process.execPath, ["--test", ...files, ".cursor/hooks/review-gate.test.mjs"], { stdio: "inherit" });
process.exit(result.status ?? 1);

function walk(dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  });
}
