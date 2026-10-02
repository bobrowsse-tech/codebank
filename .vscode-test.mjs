import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "packages/vscode/out-test/**/*.test.js",
  version: "1.101.0",
  extensionDevelopmentPath: "packages/vscode",
  workspaceFolder: "fixtures/workspace",
  mocha: { timeout: 20000 },
});
