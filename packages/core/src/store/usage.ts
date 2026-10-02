import fs from "node:fs";
import path from "node:path";
import { logStage } from "../log";
import type { UsageEvent } from "../model/types";
import { atomicWrite } from "./atomic";
import { withLock } from "./lock";
import { bankPaths } from "./paths";

export async function appendUsageLocked(home: string, event: UsageEvent): Promise<void> {
  await withLock(bankPaths(home).lock, () => appendUsage(home, event));
}

export function appendUsage(home: string, event: UsageEvent): void {
  const file = bankPaths(home).usage;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  logStage("usage", "out", { kind: event.kind, surface: event.surface, slug: event.slug });
}

export function readUsage(home: string): UsageEvent[] {
  const file = bankPaths(home).usage;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UsageEvent);
}

export function purgeUsage(home: string): void {
  const file = bankPaths(home).usage;
  if (fs.existsSync(file)) atomicWrite(file, "");
  logStage("usage", "out", { purged: true });
}
