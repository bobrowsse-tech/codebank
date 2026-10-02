import fs from "node:fs";
import { logStage } from "../log";
import type { BankConfig } from "../model/types";
import { atomicWriteJson, readJson } from "../store/atomic";
import { loadConfig, saveConfig } from "../store/config";
import { withLock } from "../store/lock";
import { bankPaths } from "../store/paths";
import { appendUsage } from "../store/usage";

interface RecallState {
  schema: 1;
  shownAt: Record<string, number>;
  dismissedAt: Record<string, number>;
  dismissals: Record<string, number>;
  muted: string[];
  shownCount: number;
  acceptedCount: number;
}

function empty(): RecallState {
  return { schema: 1, shownAt: {}, dismissedAt: {}, dismissals: {}, muted: [], shownCount: 0, acceptedCount: 0 };
}

function statePath(home: string): string {
  return bankPaths(home).recall;
}

export function loadRecall(home: string): RecallState {
  const file = statePath(home);
  if (!fs.existsSync(file)) return empty();
  const raw = readJson<Partial<RecallState>>(file);
  return {
    ...empty(),
    ...raw,
    shownAt: raw.shownAt ?? {},
    dismissedAt: raw.dismissedAt ?? {},
    dismissals: raw.dismissals ?? {},
    muted: raw.muted ?? [],
    schema: 1,
  };
}

export function saveRecall(home: string, state: RecallState): void {
  atomicWriteJson(statePath(home), state);
}

export async function noteShown(home: string, repoId: string, filePath: string, slug?: string): Promise<boolean> {
  return withLock(bankPaths(home).lock, () => noteShownHeld(home, repoId, filePath, slug));
}

function noteShownHeld(home: string, repoId: string, filePath: string, slug?: string): boolean {
  const state = loadRecall(home);
  const key = `${repoId}:${filePath}`;
  const now = Date.now();
  if (state.shownAt[key] && now - state.shownAt[key] < 10 * 60_000) return false;
  state.shownAt[key] = now;
  state.shownCount += 1;
  if (state.shownCount > 0 && state.shownCount % 20 === 0) adapt(home, state);
  saveRecall(home, state);
  if (slug) appendUsage(home, { t: new Date().toISOString(), kind: "shown", surface: "codelens", slug });
  logStage("recall", "out", { shown: key, shownCount: state.shownCount });
  return true;
}

export async function noteDismissed(home: string, repoId: string, slug: string, filePath = ""): Promise<void> {
  await withLock(bankPaths(home).lock, () => {
  const state = loadRecall(home);
  const key = `${repoId}:${slug}`;
  if (filePath) state.dismissedAt[`${repoId}:${filePath}`] = Date.now();
  state.dismissals[key] = (state.dismissals[key] ?? 0) + 1;
  if (state.dismissals[key] >= 3 && !state.muted.includes(key)) state.muted.push(key);
  saveRecall(home, state);
  appendUsage(home, { t: new Date().toISOString(), kind: "dismissed", surface: "codelens", slug });
  logStage("recall", "out", { dismissed: key, count: state.dismissals[key] });
  });
}

export async function noteAccepted(home: string, repoId: string, slug: string): Promise<void> {
  await withLock(bankPaths(home).lock, () => {
    const state = loadRecall(home);
    state.acceptedCount += 1;
    saveRecall(home, state);
    logStage("recall", "out", { accepted: `${repoId}:${slug}` });
  });
}

export async function muteRecall(home: string, repoId: string, slug: string): Promise<void> {
  await withLock(bankPaths(home).lock, () => {
    const state = loadRecall(home);
    const key = `${repoId}:${slug}`;
    if (!state.muted.includes(key)) state.muted.push(key);
    saveRecall(home, state);
    logStage("recall", "out", { muted: key });
  });
}

export function isMuted(home: string, repoId: string, slug: string): boolean {
  return loadRecall(home).muted.includes(`${repoId}:${slug}`);
}

export function inCooldown(home: string, repoId: string, filePath: string, now = Date.now()): boolean {
  const at = loadRecall(home).dismissedAt[`${repoId}:${filePath}`];
  return at !== undefined && now - at < 10 * 60_000;
}

function adapt(home: string, state: RecallState): void {
  const config = loadConfig(home);
  const rate = state.shownCount === 0 ? 1 : state.acceptedCount / state.shownCount;
  if (rate >= 0.25) return;
  const next = Math.min(0.9, round(config.recall.threshold + 0.05));
  if (next === config.recall.threshold) return;
  const updated: BankConfig = { ...config, recall: { ...config.recall, threshold: next } };
  saveConfig(home, updated);
  logStage("recall", "out", { threshold: next, accepted: state.acceptedCount, shown: state.shownCount });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
