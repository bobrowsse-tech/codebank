import { logStage } from "../log";
import { myersDiff } from "./diff";
import { endMarkerLine, markerLine } from "../insert/plan";
import type { Language } from "../model/types";
import { endMarkerSpan, occursOnce, parseMarkers } from "./marker";

export type UpdatePlan = { kind: "fast-forward"; result: string } | { kind: "promote" } | { kind: "conflict" };

export function planUpdate(base: string, local: string, upstream: string): UpdatePlan {
  logStage("lineage", "in", { base: base.length, local: local.length, upstream: upstream.length });
  const kind = same(local, base) ? "fast-forward" : same(upstream, base) ? "promote" : "conflict";
  logStage("lineage", "out", { kind });
  if (kind === "fast-forward") return { kind, result: upstream };
  if (kind === "promote") return { kind };
  return { kind: "conflict" };
}

export function updateReplacement(
  local: string,
  nextBody: string,
  language: Language,
  slug: string,
  version: number,
  hash: string,
  filePath?: string,
  previousBody?: string,
): { start: number; end: number; text: string } {
  const marker = parseMarkers(local).find((item) => item.slug === slug);
  const startLine = markerLine(language, slug, version, hash, filePath);
  if (!marker) {
    const at = previousBody && occursOnce(local, previousBody) ? local.indexOf(previousBody) : -1;
    if (at !== -1 && previousBody) return { start: at, end: at + previousBody.length, text: nextBody };
    return { start: 0, end: local.length, text: nextBody };
  }
  const endSpan = endMarkerSpan(local, marker.end);
  if (!endSpan) return { start: marker.start, end: local.length, text: `${startLine}\n${nextBody}` };
  const trailing = endSpan.end < local.length && local[endSpan.end] === "\n";
  const separated = nextBody.length === 0 || nextBody.endsWith("\n") ? nextBody : `${nextBody}\n`;
  const text = `${startLine}\n${separated}${endMarkerLine(language, filePath)}${trailing ? "\n" : ""}`;
  return { start: marker.start, end: trailing ? endSpan.end + 1 : endSpan.end, text };
}

function same(left: string, right: string): boolean {
  return myersDiff(left.split("\n"), right.split("\n")).every((edit) => edit.op === "equal");
}
