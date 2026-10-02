import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveHome(explicit?: string): string {
  const fromEnv = process.env.CODEBANK_HOME;
  const chosen = explicit || fromEnv || path.join(os.homedir(), ".codebank");
  return path.resolve(chosen.replace(/^~(?=$|\/)/, os.homedir()));
}

export function bankPaths(home: string) {
  return {
    home,
    config: path.join(home, "config.json"),
    entries: path.join(home, "entries"),
    inbox: path.join(home, "inbox"),
    lineage: path.join(home, "lineage"),
    usage: path.join(home, "state", "usage.jsonl"),
    dismissed: path.join(home, "state", "dismissed.json"),
    index: path.join(home, "cache", "index.json"),
    lock: path.join(home, "lock"),
  };
}

export function assertSafeRelPath(relPath: string): void {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Rejected path ${relPath}`);
  }
}

export function resolveInside(root: string, relPath: string): string {
  assertSafeRelPath(relPath);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, relPath);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  const staysInside = parentReal === rootReal || parentReal.startsWith(rootReal + path.sep);
  if (!staysInside || !target.startsWith(rootReal + path.sep)) {
    throw new Error(`Path escapes its folder: ${relPath}`);
  }
  return target;
}
