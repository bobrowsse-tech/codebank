import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function diffText(kind, options = {}) {
  if (kind === "staged") return gitOut(["diff", "--cached", "--binary"], options);
  if (kind === "amend") return amendDiff(options);
  if (kind === "outgoing") return outgoingDiff(options, false);
  if (kind === "force") return outgoingDiff(options, true);
  throw new Error(`Unknown review kind "${kind}". Use staged, outgoing, or force.`);
}

export function hashDiff(kind, options = {}) {
  return createHash("sha256").update(diffText(kind, options)).digest("hex");
}

export function pushBase(options = {}) {
  if (Object.hasOwn(options, "base")) return options.base;
  const rev = options.rev ?? "HEAD";
  if (options.remote || options.dest) {
    const remote = options.remote || "origin";
    const branch = options.dest || currentBranch(rev, options);
    if (branch && gitOk(["rev-parse", "--verify", `${remote}/${branch}`], options)) return `${remote}/${branch}`;
    if (remote === "origin" && gitOk(["rev-parse", "--verify", "origin/main"], options)) return "origin/main";
    return "";
  }
  if (gitOk(["rev-parse", "--verify", `${rev}@{upstream}`], options)) return `${rev}@{upstream}`;
  if (gitOk(["rev-parse", "--verify", "origin/main"], options)) return "origin/main";
  return "";
}

function currentBranch(rev, options) {
  if (rev && rev !== "HEAD") return rev;
  const name = gitOut(["rev-parse", "--abbrev-ref", rev || "HEAD"], options).trim();
  return name === "HEAD" ? "" : name;
}

function amendDiff(options) {
  const parent = gitOk(["rev-parse", "--verify", "HEAD^"], options) ? "HEAD^" : EMPTY_TREE;
  const tree = gitOut(["write-tree"], options).trim();
  return gitOut(["diff", "--binary", parent, tree], options);
}

function outgoingDiff(options, force) {
  const rev = options.rev ?? "HEAD";
  const base = pushBase(options);
  if (!base) return gitOut(["log", "-p", "--reverse", "--binary", rev], options);
  const ahead = gitOut(["rev-list", "--count", `${base}..${rev}`], options).trim();
  if (ahead !== "0") return gitOut(["log", "-p", "--reverse", "--binary", `${base}..${rev}`], options);
  if (!force) return "";
  return gitOut(["diff", "--binary", base, rev], options);
}

function gitOk(args, options) {
  return git(args, options).status === 0;
}

function gitOut(args, options) {
  const result = git(args, options);
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  return result.stdout;
}

function git(args, options = {}) {
  return spawnSync("git", [...(options.prefix ?? []), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}
