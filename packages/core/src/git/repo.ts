import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { logStage } from "../log";
import type { Origin } from "../model/types";

export interface RepoInfo {
  repoId: string;
  repoName: string;
  remote?: string;
  org?: string;
  commit?: string;
  root: string;
}

export function describeRepo(filePath: string): RepoInfo {
  const abs = path.resolve(filePath);
  logStage("git", "in", { filePath: abs });
  const root = git(abs, ["rev-parse", "--show-toplevel"]) ?? path.dirname(abs);
  const remote = git(root, ["remote", "get-url", "origin"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const info: RepoInfo = {
    repoId: createHash("sha1").update(remote ?? root).digest("hex"),
    repoName: remote ? repoName(remote) : path.basename(root),
    remote,
    org: remote ? orgName(remote) : undefined,
    commit,
    root,
  };
  logStage("git", "out", { repoName: info.repoName, org: info.org, commit: info.commit });
  return info;
}

export function originFor(filePath: string, relPath: string, range: Origin["range"], capturedBy: Origin["capturedBy"]): Origin {
  const repo = describeRepo(filePath);
  return {
    repoId: repo.repoId,
    repoName: repo.repoName,
    remote: repo.remote,
    org: repo.org,
    commit: repo.commit,
    relPath,
    range,
    capturedBy,
  };
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function orgName(remote: string): string | undefined {
  const parts = remote.replace(/\.git$/, "").split(/[:/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

function repoName(remote: string): string {
  const parts = remote.replace(/\.git$/, "").split(/[:/]/).filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}
