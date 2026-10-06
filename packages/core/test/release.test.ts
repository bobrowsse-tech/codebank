import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("the walkthrough, settings, and listing are ready to publish", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages/vscode/package.json"), "utf8")) as {
    publisher: string;
    icon: string;
    repository: { url: string };
    description: string;
    contributes: {
      configuration: { properties: Record<string, { markdownDescription?: string }> };
      walkthroughs: { id: string; steps: { id: string; completionEvents: string[] }[] }[];
      commands: { command: string }[];
    };
  };
  assert.equal(manifest.publisher, "bobrowsse-tech");
  assert.equal(manifest.icon, "media/icon.png");
  assert.match(manifest.repository.url, /bobrowsse-tech\/codebank$/);
  assert.match(manifest.description, /machine/);
  const settings = Object.keys(manifest.contributes.configuration.properties).sort();
  assert.deepEqual(settings, [
    "codebank.home",
    "codebank.insertDir",
    "codebank.lineage.mode",
    "codebank.recall.enabled",
    "codebank.recall.threshold",
    "codebank.scan.ignore",
    "codebank.scan.roots",
  ]);
  for (const setting of Object.values(manifest.contributes.configuration.properties)) {
    assert.ok(setting.markdownDescription && setting.markdownDescription.length > 0);
  }
  assert.match(manifest.contributes.configuration.properties["codebank.home"].markdownDescription ?? "", /telemetry/);
  const walkthrough = manifest.contributes.walkthroughs[0];
  assert.equal(walkthrough.id, "codebank.start");
  assert.deepEqual(
    walkthrough.steps.map((step) => step.id),
    ["scan", "accept", "chat"],
  );
  assert.deepEqual(walkthrough.steps[0].completionEvents, ["onCommand:codebank.mine"]);
  assert.deepEqual(walkthrough.steps[1].completionEvents, ["onContext:codebank.acceptedThree"]);
  assert.deepEqual(walkthrough.steps[2].completionEvents, ["onCommand:codebank.insert"]);
  assert.ok(manifest.contributes.commands.some((command) => command.command === "codebank.showWalkthrough"));

  const privacy = fs.readFileSync(path.join(root, "packages/vscode/PRIVACY.md"), "utf8");
  assert.match(privacy, /no telemetry/i);
  assert.match(privacy, /network/i);
  const changelog = fs.readFileSync(path.join(root, "packages/vscode/CHANGELOG.md"), "utf8");
  assert.match(changelog, /0\.1\.0/);
  const listing = fs.readFileSync(path.join(root, "packages/vscode/README.md"), "utf8");
  assert.match(listing, /#codebank/);
  assert.match(listing, /does not send telemetry/i);

  const icon = fs.readFileSync(path.join(root, "packages/vscode/media/icon.png"));
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});

test("the bug-bash script covers the ten flows", () => {
  const result = spawnSync(process.execPath, ["scripts/bug-bash.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const flow of ["deposit", "search", "insert", "scan", "inbox", "recall", "propose", "update", "promote", "retire"]) {
    assert.match(result.stdout, new RegExp(`ok  ${flow}`));
  }
  assert.match(result.stderr, /debug deposit in/);
  assert.match(result.stderr, /debug retire out/);
});
