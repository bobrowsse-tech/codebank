import fs from "node:fs";
import path from "node:path";
import { logStage } from "../log";
import type { Card, Entry } from "../model/types";
import { tuning } from "../tuning";
import { lineCount, readEntry, readEntryFiles, toCard } from "../store/entries";
import { bankPaths } from "../store/paths";
import { atomicWriteJson, readJson } from "../store/atomic";
import { requireSchema } from "../model/validate";
import { tokenize, trigrams, jaccard } from "./tokenize";
import { scoreBm25, type Bm25Document } from "./bm25";

interface StoredField {
  weight: number;
  tokens: string[];
}

interface StoredDoc {
  slug: string;
  mtimeMs: number;
  fields: StoredField[];
  trigramText: string;
  uses: number;
  lastUsedAt?: string;
  status: Entry["status"];
}

interface IndexFile {
  schema: 1;
  docs: StoredDoc[];
}

export interface SearchHit {
  card: Card;
  score: number;
}

export function searchBank(home: string, query: string, limit: number): Card[] {
  return searchScored(home, query, limit).map((hit) => hit.card);
}

export function searchScored(home: string, query: string, limit: number): SearchHit[] {
  logStage("search", "in", { query, limit });
  const index = loadIndex(home);
  const tokens = tokenize(query);
  const active = index.docs.filter((doc) => doc.status !== "retired");
  const documents: Bm25Document[] = active.map((doc) => ({ id: doc.slug, fields: doc.fields }));
  const raw = scoreBm25(documents, tokens);
  const bestRaw = Math.max(0, ...raw.values());
  let ranked: { slug: string; score: number }[];
  if (bestRaw <= 0 || tokens.length === 0) {
    const queryGrams = trigrams(query);
    ranked = active.map((doc) => ({ slug: doc.slug, score: jaccard(queryGrams, trigrams(doc.trigramText)) }));
  } else {
    ranked = active.map((doc) => ({ slug: doc.slug, score: adjust(doc, (raw.get(doc.slug) ?? 0) / bestRaw) }));
    const best = Math.max(...ranked.map((item) => item.score));
    if (best < tuning.search.weakScore) {
      const queryGrams = trigrams(query);
      ranked = active.map((doc) => ({ slug: doc.slug, score: jaccard(queryGrams, trigrams(doc.trigramText)) }));
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  const hits = ranked.slice(0, limit).flatMap((item) => {
    const entry = readEntry(home, item.slug);
    return entry ? [{ card: toCard(entry, lineCount(home, item.slug)), score: item.score }] : [];
  });
  logStage("search", "out", { count: hits.length, top: hits[0]?.card.slug });
  return hits;
}

export function loadIndex(home: string): IndexFile {
  const file = bankPaths(home).index;
  const current = currentMtimes(home);
  if (fs.existsSync(file)) {
    const cached = readJson<IndexFile>(file);
    requireSchema(cached, file);
    if (sameMtimes(cached.docs, current)) return cached;
  }
  const docs = current.map((item) => documentFor(home, item.slug, item.mtimeMs));
  const index = { schema: 1 as const, docs };
  atomicWriteJson(file, index);
  return index;
}

function currentMtimes(home: string): { slug: string; mtimeMs: number }[] {
  const root = bankPaths(home).entries;
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((slug) => {
      const file = path.join(root, slug, "entry.json");
      if (!fs.existsSync(file)) return undefined;
      return { slug, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .filter((item): item is { slug: string; mtimeMs: number } => Boolean(item));
}

function sameMtimes(docs: StoredDoc[], current: { slug: string; mtimeMs: number }[]): boolean {
  if (docs.length !== current.length) return false;
  const bySlug = new Map(docs.map((doc) => [doc.slug, doc.mtimeMs]));
  return current.every((item) => bySlug.get(item.slug) === item.mtimeMs);
}

function documentFor(home: string, slug: string, mtimeMs: number): StoredDoc {
  const entry = readEntry(home, slug);
  if (!entry) {
    return { slug, mtimeMs, fields: [], trigramText: slug, uses: 0, status: "retired" };
  }
  const identifiers = tokenize(readEntryFiles(home, slug).map((file) => file.content).join("\n"));
  const fields: StoredField[] = [
    { weight: tuning.weights.title, tokens: tokenize(entry.title) },
    { weight: tuning.weights.symbols, tokens: tokenize(entry.symbols.join(" ")) },
    { weight: tuning.weights.tags, tokens: tokenize(entry.tags.join(" ")) },
    { weight: tuning.weights.intent, tokens: tokenize(entry.intent) },
    { weight: tuning.weights.deps, tokens: tokenize(entry.deps.map((dep) => dep.name).join(" ")) },
    { weight: tuning.weights.identifiers, tokens: identifiers },
    { weight: tuning.weights.whenNot, tokens: tokenize(entry.whenNot ?? "") },
  ];
  return {
    slug,
    mtimeMs,
    fields,
    trigramText: `${entry.title} ${entry.symbols.join(" ")}`,
    uses: entry.stats.uses,
    lastUsedAt: entry.stats.lastUsedAt,
    status: entry.status,
  };
}

function adjust(doc: StoredDoc, score: number): number {
  let next = score * (1 + tuning.search.useBoost * Math.min(doc.uses, tuning.search.useBoostCap));
  if (doc.lastUsedAt && Date.now() - Date.parse(doc.lastUsedAt) < tuning.search.recentDays * 86_400_000) {
    next *= tuning.search.recentBoost;
  }
  if (doc.status === "stale") next *= tuning.search.staleFactor;
  return next;
}
