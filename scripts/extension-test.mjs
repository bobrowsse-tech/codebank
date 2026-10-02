import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

await build({
  entryPoints: ["packages/vscode/test/extension.host.ts"],
  outfile: "packages/vscode/out-test/extension.test.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

const home = path.join(process.cwd(), ".vscode-test", "bank");
fs.mkdirSync(home, { recursive: true });
const result = spawnSync("vscode-test", [], {
  stdio: "inherit",
  env: { ...process.env, CODEBANK_HOME: home },
});
process.exit(result.status ?? 1);
