import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCandidates } from "../../core/src/index.ts";
import { installSkill } from "../src/skill.ts";
import { run } from "../src/cli.ts";

test("list, search, and a missing get use the bank at CODEBANK_HOME", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-cli-"));
  const previous = process.env.CODEBANK_HOME;
  process.env.CODEBANK_HOME = home;
  try {
    assert.equal(await run(["list"]), 0);
    assert.equal(await run(["search", "filtering", "--json"]), 0);
    assert.equal(await run(["get", "missing"]), 2);
    assert.equal(await run(["doctor"]), 0);
  } finally {
    if (previous === undefined) delete process.env.CODEBANK_HOME;
    else process.env.CODEBANK_HOME = previous;
  }
});

test("propose keeps every file named after --files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-propose-home-"));
  const dir = fs.mkdtempSync(path.join(process.cwd(), "codebank-propose-"));
  const previous = process.env.CODEBANK_HOME;
  process.env.CODEBANK_HOME = home;
  try {
    const first = path.join(dir, "a.ts");
    const second = path.join(dir, "b.ts");
    fs.writeFileSync(first, "export const first = 1;\n");
    fs.writeFileSync(second, "export const second = 2;\n");
    assert.equal(await run(["propose", "--title", "Two files", "--intent", "Keeps both.", "--tags", "files", "--files", first, second]), 0);
    assert.equal(await run(["propose", "--title", "Missing", "--intent", "Unreadable.", "--files", path.join(dir, "missing.ts")]), 1);
    assert.equal(listCandidates(home)[0]?.files.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CODEBANK_HOME;
    else process.env.CODEBANK_HOME = previous;
  }
});

test("skill install copies the skill and appends five lines to AGENTS.md", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-skill-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-agents-"));
  const destination = installSkill({ target: "agents", homeDir, cwd, agentsMd: true });
  assert.equal(fs.existsSync(destination), true);
  assert.match(fs.readFileSync(destination, "utf8"), /codebank propose/);
  const agents = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8").trim().split("\n");
  assert.equal(agents.length, 5);
});
