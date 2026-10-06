import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const gate = path.join(hooksDir, "review-gate.mjs");
const stamp = path.join(hooksDir, "stamp-review.mjs");

test("review gate blocks an unreviewed commit and push, then allows the stamped diff", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  try {
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
    git(repo, ["add", "feature.txt"]);
    git(repo, ["commit", "-m", "feature"]);

    assert.equal(decision(repo, "git status").permission, "allow");
    assert.equal(decision(repo, "git log --grep=commit").permission, "allow");
    assert.equal(decision(repo, "echo git commit").permission, "allow");
    assert.equal(decision(repo, "git push").permission, "deny");
    assert.equal(decision(repo, 'git commit -m "x" && git push').permission, "deny");

    fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    assert.equal(decision(repo, 'git add staged.txt && git commit -m "x"').permission, "deny");
    git(repo, ["add", "staged.txt"]);
    assert.equal(decision(repo, 'git commit -m "x"').permission, "deny");
    assert.equal(decision(repo, 'git commit -am "x"').permission, "deny");
    assert.equal(decision(repo, 'git commit --pathspec-from-file=paths.txt -m "x"').permission, "deny");
    assert.equal(decision(repo, 'git commit -S staged.txt -m "x"').permission, "deny");
    assert.equal(decision(repo, '/usr/bin/git commit -am "x"').permission, "deny");
    assert.equal(decision(repo, 'command git commit -am "x"').permission, "deny");
    assert.equal(decision(repo, 'nice -n 10 git commit -am "x"').permission, "deny");
    assert.equal(decision(repo, `sh -c 'git commit -am "x"'`).permission, "deny");
    assert.equal(decision(repo, '(git commit -am "x")').permission, "deny");
    assert.equal(decision(repo, 'printf staged.txt | xargs git commit -m "x" --').permission, "deny");
    runStamp(repo, "staged");
    assert.equal(decision(repo, 'git commit -m "x"').permission, "allow");
    assert.equal(decision(repo, 'git commit -am "x"').permission, "deny");
    assert.equal(decision(repo, 'printf staged.txt | xargs git commit -m "x" --').permission, "deny");

    git(repo, ["checkout", "main"]);
    runStamp(repo, "outgoing");
    assert.equal(decision(repo, "git push origin feature").permission, "deny");
    git(repo, ["checkout", "feature"]);
    runStamp(repo, "outgoing");
    assert.equal(decision(repo, "git push").permission, "allow");
    assert.equal(decision(repo, "git push --all").permission, "deny");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("first push of main is reviewed when main has no upstream", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  try {
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    assert.equal(decision(repo, "git push -u origin main").permission, "deny");
    runStamp(repo, "outgoing");
    assert.equal(decision(repo, "git push -u origin main").permission, "allow");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commit and push target the repository named in the command", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  try {
    git(outer, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(outer, "outer.txt"), "outer\n");
    git(outer, ["add", "outer.txt"]);
    git(outer, ["commit", "-m", "outer"]);
    const other = path.join(outer, "other");
    fs.mkdirSync(other);
    git(other, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(other, "secret.txt"), "secret\n");
    git(other, ["add", "secret.txt"]);
    assert.equal(decision(outer, `git -C ${other} commit -m "x"`).permission, "deny");
    assert.equal(decision(outer, `cd ${other} && git commit -m "x"`).permission, "deny");
    assert.equal(decision(outer, `git --git-dir=${other}/.git --work-tree=${other} commit -m "x"`).permission, "deny");
    runStamp(other, "staged");
    assert.equal(decision(outer, `git -C ${other} commit -m "x"`).permission, "allow");
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("amend is reviewed as the whole resulting commit", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  try {
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "secret\n");
    git(repo, ["add", "secret.txt"]);
    git(repo, ["commit", "-m", "secret"]);
    fs.writeFileSync(path.join(repo, "readme.txt"), "readme\n");
    git(repo, ["add", "readme.txt"]);
    runStamp(repo, "staged");
    const stampPath = path.resolve(repo, gitOut(repo, ["rev-parse", "--git-dir"]).trim(), "codebank-review-stamp");
    const saved = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    saved.amend = "wrong";
    fs.writeFileSync(stampPath, `${JSON.stringify(saved)}\n`);
    assert.equal(decision(repo, 'git commit --amend -m "x"').permission, "deny");
    runStamp(repo, "staged");
    assert.equal(decision(repo, 'git commit --amend -m "x"').permission, "allow");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a force push behind upstream is reviewed separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(bare);
    git(bare, ["init", "--bare", "-b", "main"]);
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "one.txt"), "one\n");
    git(repo, ["add", "one.txt"]);
    git(repo, ["commit", "-m", "one"]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-u", "origin", "HEAD"]);
    fs.writeFileSync(path.join(repo, "two.txt"), "two\n");
    git(repo, ["add", "two.txt"]);
    git(repo, ["commit", "-m", "two"]);
    git(repo, ["push", "origin", "HEAD"]);
    git(repo, ["reset", "--hard", "HEAD~1"]);
    assert.equal(decision(repo, "git push").permission, "allow");
    assert.equal(decision(repo, "git push --force").permission, "deny");
    runStamp(repo, "force");
    assert.equal(decision(repo, "git push --force").permission, "allow");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a named remote, xargs, env, and an alternate index stay outside an upstream stamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  const origin = path.join(root, "origin.git");
  const backup = path.join(root, "backup.git");
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(origin);
    fs.mkdirSync(backup);
    git(origin, ["init", "--bare", "-b", "main"]);
    git(backup, ["init", "--bare", "-b", "main"]);
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["remote", "add", "backup", backup]);
    git(repo, ["push", "-u", "origin", "HEAD"]);
    git(repo, ["push", "backup", "HEAD"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "secret\n");
    git(repo, ["add", "secret.txt"]);
    git(repo, ["commit", "-m", "secret"]);
    git(repo, ["push", "origin", "HEAD"]);
    fs.writeFileSync(path.join(repo, "fix.txt"), "fix\n");
    git(repo, ["add", "fix.txt"]);
    git(repo, ["commit", "-m", "fix"]);
    runStamp(repo, "outgoing");
    assert.equal(decision(repo, "git push backup").permission, "deny");
    assert.equal(decision(repo, "git push backup HEAD").permission, "deny");
    assert.equal(decision(repo, "git push --repo backup").permission, "deny");
    assert.equal(decision(repo, "git push --repo backup HEAD:main").permission, "deny");
    assert.equal(decision(repo, "printf 'backup\\nHEAD:main\\n' | /usr/bin/xargs git push").permission, "deny");

    fs.writeFileSync(path.join(repo, "extra.txt"), "extra\n");
    const index = path.join(repo, "extra.index");
    git(repo, ["add", "extra.txt"], { GIT_INDEX_FILE: index });
    assert.equal(decision(repo, `GIT_INDEX_FILE=${index} git commit -m x`).permission, "deny");
    assert.equal(decision(repo, `GIT_INDEX_FILE=${index} bash -lc 'git commit -m x'`).permission, "deny");
    git(repo, ["add", "extra.txt"]);
    assert.equal(decision(repo, `bash -o pipefail -c 'git commit -m x'`).permission, "deny");
    assert.equal(decision(repo, `env bash -lc 'git commit -m x'`).permission, "deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook matcher reaches commit and push past a long path", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(hooksDir, "..", "hooks.json"), "utf8"));
  const matcher = new RegExp(hooks.hooks.beforeShellExecution[0].matcher);
  assert.equal(matcher.test(`git -C ${"p".repeat(500)} commit -am x`), true);
  assert.equal(matcher.test("/usr/bin/git commit -am x"), true);
  assert.equal(matcher.test("git status"), false);
});

test("a push is reviewed when the tip tree matches but the commits do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(bare);
    git(bare, ["init", "--bare", "-b", "main"]);
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-u", "origin", "HEAD"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "secret\n");
    git(repo, ["add", "secret.txt"]);
    git(repo, ["commit", "-m", "add secret"]);
    git(repo, ["rm", "secret.txt"]);
    git(repo, ["commit", "-m", "remove secret"]);
    assert.equal(decision(repo, "git push").permission, "deny");
    runStamp(repo, "outgoing");
    assert.equal(decision(repo, "git push").permission, "allow");
    assert.equal(decision(repo, "printf 'origin\\nfeature\\n' | xargs git push").permission, "deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to another ref is not covered by the upstream stamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(bare);
    git(bare, ["init", "--bare", "-b", "main"]);
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-u", "origin", "HEAD"]);
    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "secret\n");
    git(repo, ["add", "secret.txt"]);
    git(repo, ["commit", "-m", "secret"]);
    git(repo, ["push", "-u", "origin", "HEAD"]);
    fs.writeFileSync(path.join(repo, "fix.txt"), "fix\n");
    git(repo, ["add", "fix.txt"]);
    git(repo, ["commit", "-m", "fix"]);
    runStamp(repo, "outgoing");
    assert.equal(decision(repo, "git push origin HEAD:main").permission, "deny");
    runStamp(repo, "outgoing", ["--rev", "HEAD", "--base", "origin/main"]);
    assert.equal(decision(repo, "git push origin HEAD:main").permission, "allow");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("directory and environment tricks still select the dirty repository", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "codebank-review-"));
  try {
    git(outer, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(outer, "outer.txt"), "outer\n");
    git(outer, ["add", "outer.txt"]);
    git(outer, ["commit", "-m", "outer"]);
    const other = path.join(outer, "other");
    fs.mkdirSync(other);
    git(other, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(other, "secret.txt"), "secret\n");
    git(other, ["add", "secret.txt"]);
    const top = gitOut(outer, ["-C", other, "-C", ".", "rev-parse", "--show-toplevel"]).trim();
    assert.equal(fs.realpathSync(top), fs.realpathSync(other));
    assert.equal(decision(outer, `git -C ${other} -C . commit -m x`).permission, "deny");
    assert.equal(decision(outer, `pushd ${other} && git commit -m x`).permission, "deny");
    assert.equal(decision(outer, `GIT_DIR=${other}/.git GIT_WORK_TREE=${other} git commit -m x`).permission, "deny");
    assert.equal(decision(other, `(cd ${outer}) && git commit -m x`).permission, "deny");
    assert.equal(decision(other, `cd ${outer} | git commit -m x`).permission, "deny");
    assert.equal(decision(other, `cd ${outer} & git commit -m x`).permission, "deny");
    assert.equal(decision(other, `bash -lc 'git commit -m x'`).permission, "deny");
    assert.equal(decision(outer, `cd ${other} && git commit -m x`).permission, "deny");
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

function decision(repo, command) {
  const result = spawnSync(process.execPath, [gate], {
    cwd: repo,
    input: JSON.stringify({ command }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runStamp(repo, kind, extra = []) {
  const result = spawnSync(process.execPath, [stamp, kind, ...extra], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function git(repo, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...gitEnv(), ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitOut(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Review Gate",
    GIT_AUTHOR_EMAIL: "review@example.com",
    GIT_COMMITTER_NAME: "Review Gate",
    GIT_COMMITTER_EMAIL: "review@example.com",
  };
}
