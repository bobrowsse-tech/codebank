import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash } from "../closure/hash";
import { heuristicClosure, languageFromFile, withRequiredImports } from "../closure/extract";
import { describeRepo } from "../git/repo";
import { logStage } from "../log";
import type { Candidate } from "../model/types";
import { freeSlug, toSlug } from "../model/validate";
import { scanSecrets } from "../security/secrets";
import { resolveOwnership } from "../security/ownership";
import { listEntries } from "../store/entries";
import { ensureHome, loadConfig } from "../store/config";
import { listCandidates, listDismissed, writeCandidate } from "../store/inbox";
import { tokenize } from "../search/tokenize";
import { bandKey, minhash, shingleJaccard, shingles } from "./fingerprint";
import { extractUnits } from "./units";

export interface MineProgress {
  repo: string;
  reposDone: number;
  reposTotal: number;
  files: number;
  clusters: number;
}

export interface MineResult {
  candidates: Candidate[];
  files: number;
  repos: number;
  clusters: number;
  elapsedMs: number;
  cancelled: boolean;
  machine: string;
}

interface FoundUnit {
  repoRoot: string;
  repoName: string;
  repoId: string;
  org?: string;
  relPath: string;
  absPath: string;
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  content: string;
  lines: number;
  mtimeMs: number;
  hasTest: boolean;
  grams: Set<string>;
  signature: Uint32Array;
}

export async function mine(
  home: string,
  options: { roots: string[]; signal?: AbortSignal; ignore?: string[]; onProgress?: (progress: MineProgress) => void },
): Promise<MineResult> {
  const started = performance.now();
  logStage("mining", "in", { roots: options.roots.length });
  const config = ensureHome(home);
  const ignore = options.ignore ?? config.scan.ignore;
  const repos = findRepos(options.roots, ignore);
  const units: FoundUnit[] = [];
  let files = 0;
  for (let index = 0; index < repos.length; index += 1) {
    if (options.signal?.aborted) return finish(home, [], files, repos.length, 0, started, true);
    const repo = repos[index];
    files += await collectRepo(repo, units, config.scan.maxFileKB, ignore, options.signal);
    if (options.signal?.aborted) return finish(home, [], files, repos.length, 0, started, true);
    await new Promise((resolve) => setImmediate(resolve));
    options.onProgress?.({
      repo: path.basename(repo),
      reposDone: index + 1,
      reposTotal: repos.length,
      files,
      clusters: 0,
    });
  }
  if (options.signal?.aborted) return finish(home, [], files, repos.length, 0, started, true);
  const clusters = clusterUnits(units, options.signal);
  if (!clusters || options.signal?.aborted) return finish(home, [], files, repos.length, 0, started, true);
  const admitted = clusters.filter(admit);
  const candidates = emitCandidates(home, admitted).slice(0, 50);
  for (const candidate of candidates) await writeCandidate(home, candidate);
  options.onProgress?.({
    repo: "",
    reposDone: repos.length,
    reposTotal: repos.length,
    files,
    clusters: admitted.length,
  });
  const result = finish(home, candidates, files, repos.length, admitted.length, started, false);
  logStage("mining", "out", { candidates: result.candidates.length, files, elapsedMs: result.elapsedMs });
  return result;
}

export function machineSummary(): string {
  const cpu = os.cpus()[0]?.model ?? "unknown cpu";
  return `${os.platform()} ${os.arch()} ${cpu} ${os.cpus().length} cores ${Math.round(os.totalmem() / 1e9)} GB`;
}

function finish(
  home: string,
  candidates: Candidate[],
  files: number,
  repos: number,
  clusters: number,
  started: number,
  cancelled: boolean,
): MineResult {
  void home;
  return {
    candidates,
    files,
    repos,
    clusters,
    elapsedMs: performance.now() - started,
    cancelled,
    machine: machineSummary(),
  };
}

function findRepos(roots: string[], ignore: string[]): string[] {
  const found = new Set<string>();
  for (const root of roots) walk(path.resolve(root), 0, found, ignore);
  return [...found];
}

function walk(dir: string, depth: number, found: Set<string>, ignore: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  if (fs.existsSync(path.join(dir, ".git"))) {
    found.add(dir);
    return;
  }
  if (depth >= 4) return;
  for (const name of fs.readdirSync(dir)) {
    if (ignore.includes(name) || name === ".git") continue;
    const full = path.join(dir, name);
    let child: fs.Stats;
    try {
      child = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (child.isSymbolicLink() || !child.isDirectory()) continue;
    walk(full, depth + 1, found, ignore);
  }
}

async function collectRepo(repoRoot: string, units: FoundUnit[], maxFileKB: number, ignore: string[], signal?: AbortSignal): Promise<number> {
  const info = describeRepo(repoRoot);
  const listed = gitFiles(repoRoot);
  let count = 0;
  const names = new Set(listed);
  for (const rel of listed) {
    if (count % 250 === 0) {
      if (signal?.aborted) return count;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!wanted(rel, ignore)) continue;
    const abs = path.join(repoRoot, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxFileKB * 1024) continue;
    count += 1;
    const source = fs.readFileSync(abs, "utf8");
    const hasTest = siblingTest(rel, names);
    for (const unit of extractUnits(source)) {
      const grams = shingles(unit.content);
      units.push({
        repoRoot,
        repoName: info.repoName,
        repoId: info.repoId,
        org: info.org,
        relPath: rel.split(path.sep).join("/"),
        absPath: abs,
        name: unit.name,
        exported: unit.exported,
        startLine: unit.startLine,
        endLine: unit.endLine,
        content: unit.content,
        lines: unit.endLine - unit.startLine + 1,
        mtimeMs: stat.mtimeMs,
        hasTest,
        grams,
        signature: minhash(grams),
      });
    }
  }
  return count;
}

function gitFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function wanted(rel: string, ignore: string[]): boolean {
  if (!/\.(tsx|ts|jsx|js)$/.test(rel)) return false;
  const parts = rel.split(/[/\\]/);
  if (parts.some((part) => ignore.includes(part) || part === "generated" || part === "__tests__")) return false;
  if (rel.endsWith(".d.ts") || rel.endsWith(".min.js") || /\.(test|spec)\.(tsx|ts|jsx|js)$/.test(rel)) return false;
  return true;
}

function siblingTest(rel: string, names: Set<string>): boolean {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel).replace(/\.(tsx|ts|jsx|js)$/, "");
  const prefix = dir === "." ? "" : `${dir}/`;
  return [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx"].some((ext) => names.has(`${prefix}${base}${ext}`));
}

function clusterUnits(units: FoundUnit[], signal?: AbortSignal): FoundUnit[][] | undefined {
  const parent = units.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    let again = index;
    while (parent[again] !== cursor) {
      const next = parent[again];
      parent[again] = cursor;
      again = next;
    }
    return cursor;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const identical = new Map<string, number[]>();
  units.forEach((unit, index) => {
    const key = createHash("sha1").update([...unit.grams].sort().join("\n")).digest("hex");
    const group = identical.get(key);
    if (group) group.push(index);
    else identical.set(key, [index]);
  });
  for (const group of identical.values()) {
    for (let index = 1; index < group.length; index += 1) union(group[0], group[index]);
  }
  const buckets = new Map<string, number[]>();
  units.forEach((unit, index) => {
    for (let band = 0; band < 16; band += 1) {
      const key = `${band}:${bandKey(unit.signature, band)}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    }
  });
  const seen = new Set<string>();
  for (const bucket of buckets.values()) {
    if (signal?.aborted) return undefined;
    if (bucket.length < 2 || bucket.length > 32) continue;
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const a = bucket[left];
        const b = bucket[right];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (seen.has(key) || find(a) === find(b)) continue;
        seen.add(key);
        if (shingleJaccard(units[a].grams, units[b].grams) >= 0.8) union(a, b);
      }
    }
  }
  const groups = new Map<number, FoundUnit[]>();
  units.forEach((unit, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(unit);
    else groups.set(root, [unit]);
  });
  return [...groups.values()];
}

function admit(group: FoundUnit[]): boolean {
  const repos = new Set(group.map((unit) => unit.repoRoot));
  if (repos.size >= 2) return true;
  const unit = group[0];
  return group.length === 1 && unit.exported && unit.hasTest && unit.lines >= 20 && unit.lines <= 150;
}

function emitCandidates(home: string, groups: FoundUnit[][]): Candidate[] {
  const config = loadConfig(home);
  const banked = new Set(listEntries(home).map((entry) => entry.slug));
  const skipped = new Set([...listDismissed(home), ...listCandidates(home).map((candidate) => candidate.id)]);
  const taken = new Set([...banked, ...listCandidates(home).map((candidate) => candidate.draft.slug)]);
  const ranked = groups
    .map((group) => ({ group, score: rank(group) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  const candidates: Candidate[] = [];
  for (const item of ranked) {
    const id = clusterId(item.group);
    if (skipped.has(id)) continue;
    const representative = pickRepresentative(item.group);
    const slug = toSlug(representative.name);
    if (banked.has(slug)) continue;
    const unique = freeSlug(slug, taken);
    taken.add(unique);
    const closure = heuristicClosure(representative.absPath, {
      startLine: representative.startLine,
      endLine: representative.endLine,
    });
    if (!representative.exported) continue;
    const primary = closure.files[0]?.content ?? representative.content;
    let restored = primary;
    try {
      restored = withRequiredImports(fs.readFileSync(representative.absPath, "utf8"), primary);
    } catch {
      restored = primary;
    }
    const files = closure.files.length > 0
      ? [{ ...closure.files[0], content: restored }, ...closure.files.slice(1)]
      : [{ relPath: representative.relPath, content: restored }];
    if (scanSecrets(files.map((file) => file.content).join("\n")).some((finding) => finding.severity === "block")) continue;
    const ownership = resolveOwnership(representative.org, config);
    const candidate: Candidate = {
      schema: 1,
      id,
      draft: {
        schema: 1,
        slug: unique,
        title: representative.name,
        version: 1,
        contentHash: contentHash(files),
        language: languageFromFile(representative.absPath),
        entryFile: files[0]?.relPath ?? representative.relPath,
        symbols: [representative.name],
        tags: tokenize(representative.name).slice(0, 8),
        intent: "",
        deps: closure.deps,
        origin: {
          repoId: representative.repoId,
          repoName: representative.repoName,
          org: representative.org,
          relPath: representative.relPath,
          range: { startLine: representative.startLine, endLine: representative.endLine },
          capturedBy: "mining",
        },
        ownership,
      },
      files,
      score: item.score,
      reasons: reasons(item.group, item.score),
      sources: item.group.map((unit) => ({
        repoId: unit.repoId,
        repoName: unit.repoName,
        org: unit.org,
        relPath: unit.relPath,
        range: { startLine: unit.startLine, endLine: unit.endLine },
        capturedBy: "mining" as const,
      })),
      proposedBy: "mining",
      createdAt: new Date().toISOString(),
    };
    candidates.push(candidate);
  }
  return candidates;
}

function pickRepresentative(group: FoundUnit[]): FoundUnit {
  const exported = group.filter((unit) => unit.exported);
  const pool = exported.length > 0 ? exported : group;
  const tested = pool.filter((unit) => unit.hasTest);
  const choice = tested.length > 0 ? tested : pool;
  return choice.reduce((best, unit) => (unit.mtimeMs > best.mtimeMs ? unit : best));
}

function rank(group: FoundUnit[]): number {
  const repos = new Set(group.map((unit) => unit.repoRoot)).size;
  const representative = pickRepresentative(group);
  const hasTest = group.some((unit) => unit.hasTest) ? 1 : 0;
  const recency = recencyScore(representative.mtimeMs);
  const sizeFit = sizeScore(representative.lines);
  const exported = representative.exported ? 1 : 0;
  let score = 0.45 * Math.min(repos / 3, 1) + 0.15 * hasTest + 0.15 * recency + 0.15 * sizeFit + 0.1 * exported;
  if (scanSecrets(group.map((unit) => unit.content).join("\n")).length > 0) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

function recencyScore(mtimeMs: number): number {
  const months = (Date.now() - mtimeMs) / (30.44 * 24 * 60 * 60 * 1000);
  if (months <= 12) return 1;
  if (months >= 36) return 0;
  return 1 - (months - 12) / 24;
}

function sizeScore(lines: number): number {
  if (lines >= 20 && lines <= 120) return 1;
  if (lines < 20) return Math.max(0, (lines - 8) / 12);
  return Math.max(0, (200 - lines) / 80);
}

function reasons(group: FoundUnit[], score: number): string[] {
  const repos = new Set(group.map((unit) => unit.repoName));
  const notes = [`${repos.size} repos`, ...[...repos]];
  if (group.some((unit) => unit.hasTest)) notes.push("has a test");
  if (group.some((unit) => unit.exported)) notes.push("exported");
  if (score < 0.3) notes.push("secret-like tokens lowered the score");
  return notes;
}

function clusterId(group: FoundUnit[]): string {
  const key = group
    .map((unit) => `${unit.repoId}:${unit.relPath}:${unit.startLine}:${fingerprintOf(unit)}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function fingerprintOf(unit: FoundUnit): string {
  return [...unit.grams].sort().join("|");
}

