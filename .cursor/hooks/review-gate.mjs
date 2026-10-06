#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { diffText, pushBase } from "./review-diff.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const command = String(input.command ?? "");
const actions = collect(command, process.cwd());

if (actions.length === 0) allow();

try {
  if (actions.some((action) => action.verb === "commit") && actions.some((action) => action.verb === "push")) {
    deny(
      "Commit and push separately so the push is reviewed after the commit exists.",
      "Do not commit and push in one command. Review and stamp the staged diff, commit, then review and stamp the outgoing diff before pushing.",
    );
  }
  if (actions.some((action) => action.verb === "commit") && actions.some((action) => action.verb === "stage")) {
    deny(
      "Stage the files first, then commit after the review.",
      "Do not stage and commit in one command. Run git add, follow .cursor/skills/pre-commit-review/SKILL.md on the staged diff, run `node .cursor/hooks/stamp-review.mjs staged`, then commit.",
    );
  }
  if (actions.some((action) => action.verb === "commit" && action.takesUnstaged)) {
    deny(
      "Stage the files with git add so the review matches the commit.",
      "Do not use git commit -a, --all, pathspecs, or --pathspec-from-file. Stage the intended files, review `git diff --cached`, run `node .cursor/hooks/stamp-review.mjs staged`, then commit that index.",
    );
  }
  if (actions.some((action) => action.verb === "push" && action.blocked)) {
    deny(
      "Push one branch with git push origin HEAD.",
      "This push deletes a remote ref, pushes every branch, pushes more than one ref, or hides the ref behind xargs. Review that branch and push it on its own.",
    );
  }
  if (actions.some((action) => action.unknownDir)) {
    deny(
      "The review cannot tell which repository this git command will use.",
      "Do not use popd, or pushd without a directory, before git commit or git push. Use cd path && git so the repository is explicit.",
    );
  }

  const missing = [];
  for (const action of actions) {
    if (action.verb !== "commit" && action.verb !== "push") continue;
    if (action.dryRun) continue;
    const key = action.verb === "push" ? (action.force ? "force" : "outgoing") : (action.amend ? "amend" : "staged");
    const options = {
      cwd: action.cwd,
      prefix: action.prefix,
      env: action.env,
      rev: action.rev,
      dest: action.dest,
      remote: action.remote,
    };
    const text = diffText(key, options);
    if (text.length === 0) continue;
    const digest = createHash("sha256").update(text).digest("hex");
    if (readStamp(action)[key] !== digest) missing.push({ key, command: stampCommand(action, key, options) });
  }
  if (missing.length === 0) allow();
  const verbs = [...new Set(missing.map((item) => (item.key === "outgoing" || item.key === "force" ? "push" : "commit")))].join(" and ");
  const names = [...new Set(missing.map((item) => item.key))].join(" and ");
  const stamps = [...new Set(missing.map((item) => item.command))].join(" && ");
  deny(
    `A reviewer has to check this diff before git ${verbs}.`,
    `Do not ${verbs} yet. Follow .cursor/skills/pre-commit-review/SKILL.md on the ${names} diff. Fix every blocking finding. Only after that review reports none, run \`${stamps}\` and retry the git command.`,
  );
} catch (error) {
  deny(
    "The pre-commit review gate failed, so the git command was blocked.",
    `The review gate failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function stampCommand(action, key, options) {
  const script = `node .cursor/hooks/stamp-review.mjs ${key === "amend" ? "staged" : key}`;
  if (action.verb !== "push" || !action.dest) return script;
  const base = pushBase(options);
  return `${script} --rev '${action.rev ?? "HEAD"}' --base '${base}'`;
}

function collect(command, start, inherited = {}) {
  const actions = [];
  let cwd = start;
  let unknown = false;
  for (const part of splitShell(command)) {
    const text = part.text.trim();
    if (text.startsWith("(") && text.endsWith(")")) {
      actions.push(...collect(text.slice(1, -1), cwd, inherited));
      continue;
    }
    const words = tokens(text);
    const directory = directoryChange(words);
    if (directory !== undefined) {
      if (carries(part.sep)) {
        if (directory === null) unknown = true;
        else cwd = path.resolve(cwd, directory);
      }
      continue;
    }
    const script = shellScript(words);
    if (script) {
      const env = { ...inherited, ...gitProcessEnv(words, words.length, cwd) };
      actions.push(...collect(script, cwd, env));
      continue;
    }
    actions.push(...gitActions(words, cwd, unknown, inherited));
  }
  return actions;
}

function gitActions(words, cwd, unknown, inherited = {}) {
  const gitAt = findGit(words);
  if (gitAt < 0) return [];
  const invocation = parseGit(words, gitAt, cwd);
  invocation.env = { ...inherited, ...(invocation.env ?? {}) };
  if (!invocation.sub) return [];
  if (["add", "rm", "mv"].includes(invocation.sub)) return [{ verb: "stage", cwd: invocation.cwd }];
  if (invocation.sub === "commit") {
    return [{
      verb: "commit",
      cwd: invocation.cwd,
      prefix: invocation.prefix,
      env: invocation.env,
      unknownDir: unknown,
      takesUnstaged: invocation.xargs || commitTakesUnstaged(invocation.args),
      amend: invocation.args.some((arg) => arg === "--amend" || arg.startsWith("--amend=")),
    }];
  }
  if (invocation.sub === "push") {
    const action = parsePush(invocation);
    action.unknownDir = unknown;
    if (invocation.xargs || wordsHave(words.slice(0, findGit(words)), "xargs")) action.blocked = true;
    return [action];
  }
  return [];
}

function parsePush(invocation) {
  const action = {
    verb: "push",
    cwd: invocation.cwd,
    prefix: invocation.prefix,
    env: invocation.env,
    rev: "HEAD",
    dest: "",
    remote: "",
    force: false,
    dryRun: false,
    blocked: false,
  };
  const takesValue = new Set(["--repo", "--exec", "--receive-pack", "--signed", "-o", "--push-option", "--recurse-submodules"]);
  const positionals = [];
  for (let i = 0; i < invocation.args.length; i++) {
    const token = invocation.args[i];
    if (token === "--") {
      positionals.push(...invocation.args.slice(i + 1));
      break;
    }
    if (token === "--all" || token === "--mirror" || token === "--tags") action.blocked = true;
    if (token === "--force" || token === "-f" || token === "--force-with-lease" || token.startsWith("--force-with-lease=") || token === "--force-if-includes") action.force = true;
    if (token === "--dry-run" || token === "-n") action.dryRun = true;
    if (token.startsWith("-") && !token.startsWith("--")) {
      if (token.includes("f")) action.force = true;
      if (token.includes("n")) action.dryRun = true;
      continue;
    }
    const name = token.split("=")[0];
    if (token.startsWith("--")) {
      if (name === "--repo") action.remote = token.includes("=") ? token.slice(token.indexOf("=") + 1) : invocation.args[++i] ?? "";
      else if (!token.includes("=") && takesValue.has(name)) i += 1;
      continue;
    }
    positionals.push(token);
  }
  const remoteNames = remotes(invocation);
  let refspecs = positionals;
  if (positionals.length > 0 && (remoteNames.has(positionals[0]) || (positionals.length > 1 && !positionals[0].includes(":")))) {
    action.remote = positionals[0];
    refspecs = positionals.slice(1);
  }
  if (refspecs.length > 1) action.blocked = true;
  if (refspecs.length === 1) {
    if (refspecs[0].startsWith("+")) action.force = true;
    const spec = refspecs[0].replace(/^\+/, "");
    const src = spec.split(":")[0];
    const dst = spec.includes(":") ? spec.split(":").slice(1).join(":") : "";
    if (!src || spec.startsWith(":")) action.blocked = true;
    else {
      action.rev = src;
      if (dst || src !== "HEAD") action.dest = dst || src;
    }
  }
  return action;
}

function commitTakesUnstaged(args) {
  const takesValue = new Set([
    "-m", "--message", "-F", "--file", "--author", "--date", "-C", "-c",
    "--reuse-message", "--reedit-message", "--fixup", "--squash", "-t", "--template",
    "--cleanup", "-u", "--untracked-files", "--trailer",
  ]);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") return args.length > i + 1;
    if (token === "--all" || token === "-a" || token === "--pathspec-from-file" || token.startsWith("--pathspec-from-file=")) return true;
    if (token.startsWith("-") && !token.startsWith("--")) {
      const letters = token.slice(1);
      if (letters.includes("a")) return true;
      if ("mFcctu".includes(letters.at(-1) ?? "")) i += 1;
      continue;
    }
    const name = token.split("=")[0];
    if (token.startsWith("--")) {
      if (!token.includes("=") && takesValue.has(name)) i += 1;
      continue;
    }
    return true;
  }
  return false;
}

function parseGit(words, gitAt, cwd) {
  const prefix = [];
  let repoCwd = cwd;
  let i = gitAt + 1;
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
  for (; i < words.length; i++) {
    const token = words[i];
    if (token === "--" || !token.startsWith("-")) break;
    const name = token.split("=")[0];
    const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
    const value = inline || (takesValue.has(name) ? words[++i] ?? "" : "");
    if (name === "-C" && value) repoCwd = path.resolve(repoCwd, value);
    else if (value && takesValue.has(name)) prefix.push(inline ? token : name, ...(inline ? [] : [value]));
  }
  return {
    sub: words[i] ?? "",
    args: words.slice(i + 1),
    cwd: repoCwd,
    prefix: [...envPrefix(words, gitAt, repoCwd), ...prefix],
    env: gitProcessEnv(words, gitAt, repoCwd),
    xargs: words.slice(0, gitAt).some((word) => baseName(word) === "xargs"),
  };
}

function gitProcessEnv(words, gitAt, cwd) {
  const env = {};
  const paths = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]);
  for (const word of words.slice(0, gitAt)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
    if (!match || !match[1].startsWith("GIT_")) continue;
    env[match[1]] = paths.has(match[1]) ? path.resolve(cwd, match[2]) : match[2];
  }
  return env;
}

function baseName(word) {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

function wordsHave(words, name) {
  return words.some((word) => baseName(word) === name);
}

function envPrefix(words, gitAt, cwd) {
  const prefix = [];
  for (const word of words.slice(0, gitAt)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
    if (!match) continue;
    if (match[1] === "GIT_DIR") prefix.push("--git-dir", path.resolve(cwd, match[2]));
    if (match[1] === "GIT_WORK_TREE") prefix.push("--work-tree", path.resolve(cwd, match[2]));
  }
  return prefix;
}

function findGit(words) {
  if (words[0] === "echo" || words[0] === "printf" || words[0] === "cat") return -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "git" || words[i].endsWith("/git")) return i;
  }
  return -1;
}

function remotes(invocation) {
  const result = spawnSync("git", [...invocation.prefix, "remote"], {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(invocation.env ?? {}) },
  });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split("\n").filter(Boolean));
}

function splitShell(command) {
  const found = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (depth === 0 && (ch === "\n" || ch === ";" || ch === "&" || ch === "|")) {
      let sep = ch;
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        sep += ch;
        i += 1;
      }
      if (current.trim()) found.push({ text: current.trim(), sep });
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) found.push({ text: current.trim(), sep: "" });
  return found;
}

function carries(sep) {
  return sep === "&&" || sep === ";" || sep === "\n" || sep === "";
}

function directoryChange(words) {
  if (words[0] === "cd" && words[1]) return words[1];
  if (words[0] === "pushd" && words[1] && !words[1].startsWith("-")) return words[1];
  if (words[0] === "popd" || words[0] === "pushd") return null;
  return undefined;
}

function shellScript(words) {
  const shells = new Set(["sh", "bash", "zsh", "dash"]);
  for (let i = 0; i < words.length; i++) {
    if (!shells.has(baseName(words[i]))) continue;
    for (let j = i + 1; j < words.length; j++) {
      const word = words[j];
      if (word === "-o" || word === "-O") {
        j += 1;
        continue;
      }
      if (word === "-c" || (word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes("c"))) return words[j + 1] ?? "";
      if (!word.startsWith("-")) return "";
    }
  }
  return "";
}

function tokens(segment) {
  const found = [];
  let current = "";
  let quote = "";
  for (const ch of segment.trim()) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) found.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) found.push(current);
  return found;
}

function readStamp(action) {
  const gitDir = spawnSync("git", [...(action.prefix ?? []), "rev-parse", "--git-dir"], {
    cwd: action.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(action.env ?? {}) },
  });
  if (gitDir.status !== 0) return {};
  const stampPath = path.join(gitDir.stdout.trim(), "codebank-review-stamp");
  const resolved = path.isAbsolute(stampPath) ? stampPath : path.join(action.cwd, stampPath);
  if (!fs.existsSync(resolved)) return {};
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function allow() {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
}

function deny(userMessage, agentMessage) {
  process.stdout.write(JSON.stringify({
    permission: "deny",
    user_message: userMessage,
    agent_message: agentMessage,
  }));
  process.exit(0);
}
