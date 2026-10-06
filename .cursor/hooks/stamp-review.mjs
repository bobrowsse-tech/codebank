#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashDiff } from "./review-diff.mjs";

const kind = process.argv[2];
if (kind !== "staged" && kind !== "outgoing" && kind !== "force") {
  console.error("Usage: node .cursor/hooks/stamp-review.mjs staged|outgoing|force");
  process.exit(1);
}

const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" });
if (gitDir.status !== 0) {
  console.error(gitDir.stderr || "git rev-parse failed");
  process.exit(1);
}

const stampPath = path.join(gitDir.stdout.trim(), "codebank-review-stamp");
const current = fs.existsSync(stampPath) ? JSON.parse(fs.readFileSync(stampPath, "utf8")) : {};
if (kind === "staged") {
  current.staged = hashDiff("staged");
  current.amend = hashDiff("amend");
} else {
  current[kind] = hashDiff(kind, stampOptions(process.argv.slice(3)));
}
fs.writeFileSync(stampPath, `${JSON.stringify(current)}\n`);
console.log(`stamped ${kind}`);

function stampOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rev") options.rev = args[++i] ?? "HEAD";
    else if (args[i] === "--base") options.base = args[++i] ?? "";
    else options.base = args[i];
  }
  return options;
}
