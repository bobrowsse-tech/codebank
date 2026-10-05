import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../closure/hash";
import { logStage } from "../log";
import type { BankConfig, Entry, Link, SourceFile } from "../model/types";
import { requireSchema } from "../model/validate";
import { atomicWriteJson, readJson } from "./atomic";
import { readEntry, saveEntry, type SaveOutcome } from "./entries";
import { withLock } from "./lock";
import { assertSafeRelPath, bankPaths } from "./paths";
import { parseMarkers, stripMarkers } from "../lineage/marker";

const repoIdPattern = /^[a-f0-9]{40}$/;

interface LineageFile {
  schema: 1;
  links: Link[];
}

export function lineageMode(config: BankConfig, ownership: Entry["ownership"], setting?: string): "marker" | "external" {
  if (setting === "external") return "external";
  if (setting === "marker") return "marker";
  if (config.lineage.mode === "external") return "external";
  if (ownership !== "personal" && config.lineage.externalForClient) return "external";
  return "marker";
}

export function readLinks(home: string, repoId: string): Link[] {
  const file = lineageFile(home, repoId);
  if (!file || !fs.existsSync(file)) return [];
  const raw = readJson<LineageFile>(file);
  requireSchema(raw, file);
  return raw.links ?? [];
}

export function listAllLinks(home: string): Link[] {
  const root = bankPaths(home).lineage;
  if (!fs.existsSync(root)) return [];
  const links: Link[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const repoId = name.slice(0, -".json".length);
    links.push(...readLinks(home, repoId));
  }
  return links;
}

export async function upsertLink(home: string, link: Link): Promise<void> {
  assertSafeRelPath(link.relPath);
  await withLock(bankPaths(home).lock, () => {
    const file = lineageFile(home, link.repoId);
    if (!file) throw new Error("A repository id must be 40 hex characters.");
    const links = fs.existsSync(file) ? readLinks(home, link.repoId) : [];
    const next = links.filter((item) => !(item.slug === link.slug && item.relPath === link.relPath));
    next.push(link);
    atomicWriteJson(file, { schema: 1, links: next });
    logStage("lineage", "out", { slug: link.slug, repoId: link.repoId, version: link.version, mode: link.mode });
  });
}

export interface UpdateNotice {
  slug: string;
  title: string;
  relPath: string;
  repoId: string;
  fromVersion: number;
  toVersion: number;
}

export function findUpdates(home: string, repoId: string, files: { relPath: string; content: string }[]): UpdateNotice[] {
  const notices: UpdateNotice[] = [];
  const seen = new Set<string>();
  const add = (slug: string, relPath: string, fromVersion: number) => {
    const entry = readEntry(home, slug);
    if (!entry || entry.version <= fromVersion) return;
    const key = `${slug}:${relPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    notices.push({ slug, title: entry.title, relPath, repoId, fromVersion, toVersion: entry.version });
  };
  for (const file of files) {
    for (const marker of parseMarkers(file.content)) add(marker.slug, file.relPath, marker.version);
  }
  if (repoIdPattern.test(repoId)) {
    for (const link of readLinks(home, repoId)) add(link.slug, link.relPath, link.version);
  }
  logStage("lineage", "out", { updates: notices.length, repoId });
  return notices;
}

export async function promoteEntry(
  home: string,
  slug: string,
  files: SourceFile[],
  link?: { repoId: string; relPath: string; mode?: Link["mode"] },
): Promise<SaveOutcome> {
  const current = readEntry(home, slug);
  if (!current) return { ok: false, reason: "invalid", problems: [`No entry named ${slug}.`] };
  logStage("lineage", "in", { promote: slug, version: current.version });
  const outcome = await saveEntry(
    home,
    {
      slug: current.slug,
      title: current.title,
      language: current.language,
      entryFile: current.entryFile,
      symbols: current.symbols,
      tags: current.tags,
      intent: current.intent,
      whenNot: current.whenNot,
      deps: current.deps,
      origin: current.origin,
      ownership: current.ownership,
    },
    files,
    { mode: "replace" },
  );
  if (outcome.ok && link) {
    await upsertLink(home, {
      slug,
      version: outcome.entry.version,
      baseHash: outcome.entry.contentHash,
      repoId: link.repoId,
      relPath: link.relPath,
      mode: link.mode ?? "marker",
      localHash: outcome.entry.contentHash,
      insertedAt: new Date().toISOString(),
    });
  }
  return outcome;
}

export async function noteLocalEdit(
  home: string,
  repoId: string,
  relPath: string,
  content: string,
): Promise<{ prompt: boolean; slug?: string; title?: string }> {
  const link = readLinks(home, repoId).find((item) => item.relPath === relPath);
  if (!link) return { prompt: false };
  const entry = readEntry(home, link.slug);
  if (!entry) return { prompt: false };
  const hash = contentHash([{ relPath: entry.entryFile, content: stripMarkers(content) }]);
  if (hash === link.localHash) return { prompt: false };
  const prompt = hash !== link.baseHash;
  await upsertLink(home, { ...link, localHash: hash });
  logStage("lineage", "out", { edited: link.slug, prompt });
  return prompt ? { prompt: true, slug: entry.slug, title: entry.title } : { prompt: false };
}

export async function markDrift(home: string, repos: { repoId: string; packageJson: string }[]): Promise<string[]> {
  const byRepo = new Map(repos.map((repo) => [repo.repoId, repo.packageJson]));
  const stale: string[] = [];
  await withLock(bankPaths(home).lock, () => {
    const grouped = new Map<string, Link[]>();
    for (const link of listAllLinks(home)) {
      const list = grouped.get(link.slug) ?? [];
      list.push(link);
      grouped.set(link.slug, list);
    }
    for (const [slug, links] of grouped) {
      const entry = readEntry(home, slug);
      if (!entry || entry.status === "retired") continue;
      const recent = [...links].sort((left, right) => right.insertedAt.localeCompare(left.insertedAt));
      const reposSeen: string[] = [];
      for (const link of recent) {
        if (!reposSeen.includes(link.repoId)) reposSeen.push(link.repoId);
        if (reposSeen.length === 5) break;
      }
      const counts = new Map<string, number>();
      for (const repoId of reposSeen) {
        const packageJson = byRepo.get(repoId);
        if (!packageJson) continue;
        const installed = readInstalled(packageJson);
        for (const dep of entry.deps) {
          const have = installed.get(dep.name);
          if (have !== undefined && majorNumber(have) > majorNumber(dep.range)) counts.set(dep.name, (counts.get(dep.name) ?? 0) + 1);
        }
      }
      const reason = [...counts.entries()].find(([, count]) => count >= 2)?.[0];
      if (!reason || (entry.status === "stale" && entry.staleReason === reason)) continue;
      const file = path.join(bankPaths(home).entries, slug, "entry.json");
      atomicWriteJson(file, { ...entry, status: "stale", staleReason: reason, updatedAt: new Date().toISOString() });
      stale.push(slug);
      logStage("lineage", "out", { stale: slug, reason });
    }
  });
  return stale;
}

function lineageFile(home: string, repoId: string): string | undefined {
  if (!repoIdPattern.test(repoId)) return undefined;
  return path.join(bankPaths(home).lineage, `${repoId}.json`);
}

function readInstalled(packageJson: string): Map<string, string> {
  if (!fs.existsSync(packageJson)) return new Map();
  const json = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return new Map(Object.entries({ ...json.devDependencies, ...json.dependencies }));
}

function majorNumber(range: string): number {
  const match = range.match(/\d+/);
  return match ? Number(match[0]) : 0;
}
