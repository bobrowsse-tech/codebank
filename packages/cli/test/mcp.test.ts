import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCandidates, listEntries } from "../../core/src/index.ts";

test("the mcp server speaks raw json lines", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-mcp-"));
  const child = spawn(process.execPath, [path.join("packages/cli/dist/cli.js"), "mcp"], {
    cwd: process.cwd(),
    env: { ...process.env, CODEBANK_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending: Array<(line: string) => void> = [];
  const queued: string[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = pending.shift();
      if (waiter) waiter(line);
      else queued.push(line);
      newline = buffer.indexOf("\n");
    }
  });
  const next = () =>
    new Promise<string>((resolve, reject) => {
      const line = queued.shift();
      if (line) resolve(line);
      else {
        const timer = setTimeout(() => reject(new Error(`no response\n${stderr}`)), 5_000);
        pending.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }
    });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  const initialized = JSON.parse(await next()) as { result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } };
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  assert.equal(initialized.result.serverInfo.name, "codebank");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(JSON.parse(await next()).result, {});

  send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const listed = JSON.parse(await next()) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["codebank_search", "codebank_get", "codebank_propose"],
  );

  send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "codebank_search", arguments: { query: { bad: true } } } });
  assert.equal(JSON.parse(await next()).error.code, -32602);

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "codebank_search", arguments: { query: "filtering" } } });
  const search = JSON.parse(await next()) as { result: { content: Array<{ text: string }> } };
  assert.match(search.result.content[0].text, /No bank matches/);

  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "codebank_propose",
      arguments: {
        title: "Format currency",
        intent: "Formats cents.",
        tags: ["currency"],
        files: [{ relPath: "src/format.ts", content: "export const amount = 1;\n" }],
        deps: [{ name: "lodash", range: "^4.17.21" }],
      },
    },
  });
  const proposed = JSON.parse(await next()) as { result: { content: Array<{ text: string }> } };
  assert.match(proposed.result.content[0].text, /inbox/);
  assert.equal(listEntries(home).length, 0);
  assert.equal(listCandidates(home).length, 1);
  assert.equal(listCandidates(home)[0]?.proposedBy, "agent");
  assert.deepEqual(listCandidates(home)[0]?.draft.deps, [{ name: "lodash", range: "^4.17.21" }]);

  send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "codebank_propose",
      arguments: { title: { bad: true }, intent: "Formats cents.", tags: ["currency"], files: [{ relPath: "src/format.ts", content: "export const amount = 1;\n" }] },
    },
  });
  assert.equal(JSON.parse(await next()).error.code, -32602);

  child.stdin.write("null\n");
  assert.equal(JSON.parse(await next()).error.code, -32600);

  send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "codebank_get", arguments: { slug: { bad: true } } } });
  assert.equal(JSON.parse(await next()).error.code, -32602);

  send({ jsonrpc: "2.0", id: 6, method: "tools/missing" });
  assert.equal(JSON.parse(await next()).error.code, -32601);

  child.stdin.end();
  const exit = await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  assert.equal(exit, 0);
  assert.equal(stderr.includes("{"), false);
});
