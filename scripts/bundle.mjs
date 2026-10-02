import fs from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["packages/core/src/index.ts"],
  outfile: "packages/core/dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});

await build({
  entryPoints: ["packages/cli/src/cli.ts"],
  outfile: "packages/cli/dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});
fs.copyFileSync("skills/codebank/SKILL.md", "packages/cli/dist/SKILL.md");

await build({
  entryPoints: ["packages/vscode/src/extension.ts"],
  outfile: "packages/vscode/dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

await build({
  entryPoints: ["packages/vscode/src/mine-worker.ts"],
  outfile: "packages/vscode/dist/mine-worker.js",
  bundle: true,
  platform: "node",
  format: "cjs",
});
