import { build } from "esbuild";

await build({
  entryPoints: ["packages/vscode/test/extension.host.ts"],
  outfile: "packages/vscode/out-test/extension.test.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
