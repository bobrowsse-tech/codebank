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
    recall: path.join(home, "state", "recall.json"),
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
  const rootReal = realpathCreating(root);
  const parts = relPath.split(/[\\/]/).filter((part) => part.length > 0);
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(current, parts[index]);
    if (!fs.existsSync(next)) {
      const parent = path.dirname(path.join(current, ...parts.slice(index)));
      fs.mkdirSync(parent, { recursive: true });
      const parentReal = fs.realpathSync(parent);
      if (!contained(rootReal, parentReal)) throw new Error(`Path escapes its folder: ${relPath}`);
      return path.join(parentReal, parts[parts.length - 1]);
    }
    const real = fs.realpathSync(next);
    if (!contained(rootReal, real)) throw new Error(`Path escapes its folder: ${relPath}`);
    if (index === parts.length - 1) return real;
    if (!fs.statSync(real).isDirectory()) throw new Error(`Rejected path ${relPath}`);
    current = real;
  }
  throw new Error(`Rejected path ${relPath}`);
}

function realpathCreating(root: string): string {
  const resolved = path.resolve(root);
  let cursor = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(cursor)) {
    missing.push(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Rejected path ${root}`);
    cursor = parent;
  }
  const ancestor = fs.realpathSync(cursor);
  if (missing.length === 0) return ancestor;
  const created = path.join(ancestor, ...missing.reverse());
  fs.mkdirSync(created, { recursive: true });
  return fs.realpathSync(created);
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}
