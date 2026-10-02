import assert from "node:assert/strict";
import * as vscode from "vscode";

declare function suite(name: string, fn: (this: { timeout: (ms: number) => void }) => void): void;
declare function test(name: string, fn: () => Promise<void>): void;

suite("Codebank", function () {
  this.timeout(20_000);

  test("activates against the fixture workspace", async () => {
    const extension = vscode.extensions.getExtension("bobrowsse-tech.codebank");
    assert.ok(extension, "extension is installed");
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("codebank.deposit"));
    assert.ok(commands.includes("codebank.search"));
  });
});
