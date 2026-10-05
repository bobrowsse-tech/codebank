import { logStage } from "../log";
import { myersDiff } from "./diff";
import { endMarkerLine, markerLine } from "../insert/plan";
import type { Language } from "../model/types";
import { parseMarkers } from "./marker";

export type UpdatePlan = { kind: "fast-forward"; result: string } | { kind: "promote" } | { kind: "conflict" };

export function planUpdate(base: string, local: string, upstream: string): UpdatePlan {
  logStage("lineage", "in", { base: base.length, local: local.length, upstream: upstream.length });
  const kind = same(local, base) ? "fast-forward" : same(upstream, base) ? "promote" : "conflict";
  logStage("lineage", "out", { kind });
  if (kind === "fast-forward") return { kind, result: upstream };
  if (kind === "promote") return { kind };
  return { kind: "conflict" };
}

export function updateReplacement(local: string, nextBody: string, language: Language, slug: string, version: number, hash: string): { start: number; end: number; text: string } {
  const marker = parseMarkers(local).find((item) => item.slug === slug);
  const startLine = markerLine(language, slug, version, hash);
  const endAt = marker ? local.indexOf("@codebank-end", marker.end) : -1;
  const text = endAt === -1 ? `${startLine}\n${nextBody}` : `${startLine}\n${nextBody}\n${endMarkerLine(language)}`;
  if (!marker) return { start: 0, end: local.length, text };
  const end = endAt === -1 ? local.length : lineEnd(local, endAt);
  return { start: marker.start, end, text };
}

function same(left: string, right: string): boolean {
  return myersDiff(left.split("\n"), right.split("\n")).every((edit) => edit.op === "equal");
}

function lineEnd(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline === -1 ? source.length : newline + 1;
}
