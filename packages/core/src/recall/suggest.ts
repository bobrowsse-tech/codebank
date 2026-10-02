import path from "node:path";
import { logStage } from "../log";
import type { Card } from "../model/types";
import { loadConfig } from "../store/config";
import { readEntryFiles } from "../store/entries";
import { searchScored } from "../search/index";
import { tokenize } from "../search/tokenize";
import { shingleJaccard, shingles } from "../mining/fingerprint";
import { inCooldown, isMuted } from "./state";

export interface RecallSuggestion {
  slug: string;
  title: string;
  version: number;
  uses: number;
  score: number;
  signal: "filename" | "comment" | "paste";
}

const VERBS = ["implement", "add", "write", "need", "todo"];

export function pastedText(changes: string[]): string | undefined {
  const inserted = changes.filter((text) => text.split("\n").length >= 12);
  return inserted.length === 0 ? undefined : inserted[inserted.length - 1];
}

export function suggestRecall(
  home: string,
  input: { filePath: string; text: string; repoId: string; targetOrg?: string; now?: number; enabled?: boolean; threshold?: number; pasted?: string },
): RecallSuggestion | undefined {
  const config = loadConfig(home);
  const enabled = input.enabled ?? config.recall.enabled;
  const threshold = input.threshold ?? config.recall.threshold;
  if (!enabled) return undefined;
  logStage("recall", "in", { filePath: input.filePath });
  const lines = input.text.split("\n");
  const filename = lines.length < 5 ? filenameSignal(home, input) : undefined;
  const comment = filename ? undefined : commentSignal(home, input);
  const paste = filename || comment || !input.pasted ? undefined : pasteSignal(home, { ...input, text: input.pasted });
  const suggestion = filename ?? comment ?? paste;
  if (!suggestion) return undefined;
  if (suggestion.score < threshold) return undefined;
  if (isMuted(home, input.repoId, suggestion.slug)) return undefined;
  if (inCooldown(home, input.repoId, input.filePath, input.now)) return undefined;
  logStage("recall", "out", { slug: suggestion.slug, score: suggestion.score, signal: suggestion.signal });
  return suggestion;
}

function filenameSignal(home: string, input: { filePath: string; targetOrg?: string }): RecallSuggestion | undefined {
  const base = path.basename(input.filePath).replace(/\.[^.]+$/, "");
  const query = tokenize(base)
    .map((token) => (token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token))
    .join(" ");
  if (!query) return undefined;
  return fromSearch(home, query, input.targetOrg, "filename", 0.5);
}

function commentSignal(home: string, input: { text: string; targetOrg?: string }): RecallSuggestion | undefined {
  const line = input.text.split("\n").find((item) => /^\s*(\/\/|\/\*|#)/.test(item) && VERBS.some((verb) => item.toLowerCase().includes(verb)));
  if (!line) return undefined;
  const query = tokenize(line).filter((token) => !VERBS.includes(token)).join(" ");
  if (!query) return undefined;
  return fromSearch(home, query, input.targetOrg, "comment", 0.4);
}

function pasteSignal(home: string, input: { text: string; targetOrg?: string }): RecallSuggestion | undefined {
  if (input.text.split("\n").length < 12) return undefined;
  const grams = shingles(input.text);
  const hits = searchScored(home, tokenize(input.text).slice(0, 12).join(" "), 8, { targetOrg: input.targetOrg, status: "active" });
  let best: RecallSuggestion | undefined;
  for (const hit of hits) {
    const code = readEntryFiles(home, hit.card.slug).map((file) => file.content).join("\n");
    const overlap = shingleJaccard(grams, shingles(code));
    if (overlap < 0.5) continue;
    const score = blend(overlap, 0.6, hit.card);
    if (!best || score > best.score) best = toSuggestion(hit.card, score, "paste");
  }
  return best;
}

function fromSearch(
  home: string,
  query: string,
  targetOrg: string | undefined,
  signal: RecallSuggestion["signal"],
  weight: number,
): RecallSuggestion | undefined {
  const hit = searchScored(home, query, 1, { targetOrg, status: "active" })[0];
  if (!hit) return undefined;
  return toSuggestion(hit.card, blend(hit.score, weight, hit.card), signal);
}

function blend(searchScore: number, weight: number, card: Card): number {
  return Math.min(1, 0.6 * searchScore + 0.4 * weight) + 0.05 * Math.min(card.uses, 4);
}

function toSuggestion(card: Card, score: number, signal: RecallSuggestion["signal"]): RecallSuggestion {
  return { slug: card.slug, title: card.title, version: card.version, uses: card.uses, score, signal };
}
