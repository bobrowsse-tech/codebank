import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../closure/hash";
import { logStage } from "../log";
import { problemsForEntry, problemsForFiles } from "../model/validate";
import type { Card, Entry, Origin, SourceFile } from "../model/types";
import { SchemaError } from "../model/types";
import { scanSecrets } from "../security/secrets";
import { atomicWrite, atomicWriteJson, readJson } from "./atomic";
import { withLock } from "./lock";
import { bankPaths, resolveInside } from "./paths";
import { requireSchema } from "../model/validate";

export interface SaveDraft {
  slug: string;
  title: string;
  language: Entry["language"];
  entryFile: string;
  symbols: string[];
  tags: string[];
  intent: string;
  whenNot?: string;
  deps: Entry["deps"];
  origin: Origin;
  ownership: Entry["ownership"];
  variantOf?: Entry["variantOf"];
  secretOverrides?: string[];
}

export type SaveOutcome =
  | { ok: true; entry: Entry }
  | { ok: false; reason: "secrets"; findings: ReturnType<typeof scanSecrets> }
  | { ok: false; reason: "invalid"; problems: string[] }
  | { ok: false; reason: "duplicate"; slug: string }
  | { ok: false; reason: "similar"; slug: string; score: number };

export async function saveEntry(
  home: string,
  draft: SaveDraft,
  files: SourceFile[],
  options: { similarSlug?: string; similarScore?: number; mode?: "create" | "variant" | "replace" } = {},
): Promise<SaveOutcome> {
  logStage("deposit", "in", { slug: draft.slug, files: files.map((file) => file.relPath) });
  const fileProblems = problemsForFiles(files);
  if (fileProblems.length > 0) return { ok: false, reason: "invalid", problems: fileProblems };

  const findings = scanSecrets(files.map((file) => file.content).join("\n"));
  const blocked = findings.filter((finding) => finding.severity === "block" && !draft.secretOverrides?.includes(finding.hash));
  if (blocked.length > 0) {
    logStage("deposit", "out", { blocked: blocked.map((finding) => finding.kind) });
    return { ok: false, reason: "secrets", findings: blocked };
  }

  if (options.mode !== "replace" && options.mode !== "variant") {
    const same = listEntries(home).find((entry) => entry.status === "active" && entry.contentHash === contentHash(files));
    if (same) return { ok: false, reason: "duplicate", slug: same.slug };
    if (options.similarSlug && (options.similarScore ?? 0) > 0.8) {
      return { ok: false, reason: "similar", slug: options.similarSlug, score: options.similarScore ?? 0 };
    }
  }
  if (options.mode !== "replace" && readEntry(home, draft.slug)) {
    return { ok: false, reason: "invalid", problems: [`An entry named ${draft.slug} already exists.`] };
  }

  const now = new Date().toISOString();
  const existing = options.mode === "replace" ? readEntry(home, draft.slug) : undefined;
  const entry: Entry = {
    schema: 1,
    slug: draft.slug,
    title: draft.title,
    version: existing ? existing.version + 1 : 1,
    contentHash: contentHash(files),
    language: draft.language,
    entryFile: draft.entryFile,
    symbols: draft.symbols,
    tags: draft.tags.map((tag) => tag.toLowerCase()).slice(0, 8),
    intent: draft.intent,
    whenNot: draft.whenNot,
    deps: draft.deps,
    origin: draft.origin,
    ownership: draft.ownership,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    stats: existing?.stats ?? { uses: 0, verbatimInserts: 0 },
    status: "active",
    variantOf: options.mode === "variant" ? draft.variantOf : existing?.variantOf,
    secretOverrides: draft.secretOverrides,
  };
  const problems = problemsForEntry(entry);
  if (problems.length > 0) return { ok: false, reason: "invalid", problems };

  await withLock(bankPaths(home).lock, () => {
    const dir = path.join(bankPaths(home).entries, entry.slug);
    if (existing) {
      const versionDir = path.join(dir, "versions", String(existing.version));
      fs.mkdirSync(versionDir, { recursive: true });
      atomicWriteJson(path.join(versionDir, "entry.json"), existing);
    }
    fs.mkdirSync(dir, { recursive: true });
    const codeDir = path.join(dir, "code");
    fs.rmSync(codeDir, { recursive: true, force: true });
    for (const file of files) {
      atomicWrite(resolveInside(codeDir, file.relPath), file.content);
    }
    atomicWrite(path.join(dir, "card.md"), cardMarkdown(entry));
    atomicWriteJson(path.join(dir, "entry.json"), entry);
  });
  logStage("deposit", "out", { slug: entry.slug, version: entry.version, files: files.length });
  return { ok: true, entry };
}

export function readEntry(home: string, slug: string): Entry | undefined {
  const file = path.join(bankPaths(home).entries, slug, "entry.json");
  if (!fs.existsSync(file)) return undefined;
  const raw = readJson<Entry>(file);
  try {
    requireSchema(raw, file);
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw error;
  }
  return raw;
}

export function listEntries(home: string): Entry[] {
  const root = bankPaths(home).entries;
  if (!fs.existsSync(root)) return [];
  const entries: Entry[] = [];
  for (const slug of fs.readdirSync(root)) {
    const file = path.join(root, slug, "entry.json");
    if (!fs.existsSync(file)) continue;
    const raw = readJson<Entry>(file);
    requireSchema(raw, file);
    entries.push(raw);
  }
  return entries;
}

export function readEntryFiles(home: string, slug: string): SourceFile[] {
  const codeRoot = path.join(bankPaths(home).entries, slug, "code");
  if (!fs.existsSync(codeRoot)) return [];
  const rootReal = fs.realpathSync(codeRoot);
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const real = fs.realpathSync(full);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`Path escapes its folder: ${path.relative(codeRoot, full)}`);
      }
      if (fs.statSync(real).isDirectory()) walk(real);
      else files.push({ relPath: path.relative(rootReal, real).split(path.sep).join("/"), content: fs.readFileSync(real, "utf8") });
    }
  };
  walk(rootReal);
  return files;
}

export function lineCount(home: string, slug: string): number {
  return readEntryFiles(home, slug).reduce((sum, file) => sum + file.content.split("\n").length, 0);
}

export function toCard(entry: Entry, lines: number): Card {
  return {
    slug: entry.slug,
    title: entry.title,
    intent: entry.intent,
    whenNot: entry.whenNot,
    language: entry.language,
    tags: entry.tags,
    deps: entry.deps.map((dep) => `${dep.name}@${dep.range}`),
    lines,
    version: entry.version,
    uses: entry.stats.uses,
    lastUsedAt: entry.stats.lastUsedAt,
    status: entry.status,
    ownership: entry.ownership,
    origin: `${entry.origin.repoName} · ${entry.origin.relPath}`,
  };
}

export async function recordUse(home: string, slug: string, verbatim: boolean): Promise<void> {
  await withLock(bankPaths(home).lock, () => {
    const entry = readEntry(home, slug);
    if (!entry) return;
    entry.stats.uses += 1;
    if (verbatim) entry.stats.verbatimInserts += 1;
    entry.stats.lastUsedAt = new Date().toISOString();
    entry.updatedAt = entry.stats.lastUsedAt;
    atomicWriteJson(path.join(bankPaths(home).entries, slug, "entry.json"), entry);
  });
}

export async function retireEntry(home: string, slug: string): Promise<boolean> {
  const entry = readEntry(home, slug);
  if (!entry) return false;
  entry.status = "retired";
  entry.updatedAt = new Date().toISOString();
  await withLock(bankPaths(home).lock, () => {
    atomicWriteJson(path.join(bankPaths(home).entries, slug, "entry.json"), entry);
  });
  return true;
}

function cardMarkdown(entry: Entry): string {
  const lines = [`# ${entry.title}`, "", entry.intent];
  if (entry.whenNot) lines.push("", `When not: ${entry.whenNot}`);
  return `${lines.join("\n")}\n`;
}
