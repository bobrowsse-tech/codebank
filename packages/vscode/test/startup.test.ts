import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ACTIVATION_IDLE_MS, afterActivation, idleAfterActivation, nextAcceptedCount, walkthroughAcceptsComplete } from "../src/startup.ts";

test("index work stays off the activation path and inside the idle budget", async () => {
  let ran = false;
  afterActivation(() => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(idleAfterActivation(0), true);
  assert.equal(idleAfterActivation(ACTIVATION_IDLE_MS), true);
  assert.equal(idleAfterActivation(ACTIVATION_IDLE_MS + 1), false);

  const source = fs.readFileSync(path.join(process.cwd(), "packages/vscode/src/extension.ts"), "utf8");
  const activate = source.slice(source.indexOf("export function activate"));
  const beforeCommands = activate.slice(0, activate.indexOf("context.subscriptions.push"));
  const deferred = activate.slice(activate.indexOf("afterActivation("), activate.indexOf("const homeUri"));
  const measured = activate.slice(activate.indexOf("inboxWatcher"));
  assert.equal(beforeCommands.includes("loadIndex("), false);
  assert.equal(beforeCommands.includes("noteWorkspaceDrift("), false);
  assert.equal(beforeCommands.includes("scanFolders("), false);
  assert.match(deferred, /loadIndex\(current\)/);
  assert.match(deferred, /noteWorkspaceDrift\(current\)/);
  assert.match(deferred, /scanFolders\(bankHome, refreshInbox\)/);
  assert.match(measured, /activation\.elapsedMs = Date\.now\(\) - started/);
  assert.equal(walkthroughAcceptsComplete(nextAcceptedCount(0)), false);
  assert.equal(walkthroughAcceptsComplete(nextAcceptedCount(1)), false);
  assert.equal(walkthroughAcceptsComplete(nextAcceptedCount(2)), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ran, true);
});
