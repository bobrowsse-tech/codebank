import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { languageFromFile } from "../closure/extract";
import { visibleSource } from "../mining/units";
import { contentHash } from "../closure/hash";
import { logStage } from "../log";
import { tuning } from "../tuning";
import type { Candidate, SourceFile } from "../model/types";
import { freeSlug, isPackageDep, problemsForCandidate, problemsForFiles, requireSchema, toSlug } from "../model/validate";
import { scanSecrets } from "../security/secrets";
import { atomicWriteJson, readJson } from "./atomic";
import { withLock } from "./lock";
import { listEntries, saveEntryHeld, type SaveOutcome } from "./entries";
import { assertSafeRelPath, bankPaths } from "./paths";

export function listCandidates(home: string): Candidate[] {
  const root = bankPaths(home).inbox;
  if (!fs.existsSync(root)) return [];
  const candidates: Candidate[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, name);
    const candidate = readJson<Candidate>(file);
    requireSchema(candidate, file);
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => right.score - left.score);
}

const candidateId = /^[a-f0-9]{16}$/;

function candidatePath(home: string, id: string): string | undefined {
  if (!candidateId.test(id)) return undefined;
  return path.join(bankPaths(home).inbox, `${id}.json`);
}

export function readCandidate(home: string, id: string): Candidate | undefined {
  const file = candidatePath(home, id);
  if (!file || !fs.existsSync(file)) return undefined;
  const candidate = readJson<Candidate>(file);
  requireSchema(candidate, file);
  return candidate;
}

export function writeCandidateHeld(home: string, candidate: Candidate): void {
  const problems = problemsForCandidate(candidate);
  if (problems.length > 0) throw new Error(problems.join(" "));
  const file = candidatePath(home, candidate.id);
  if (!file) throw new Error("A candidate id must be 16 lowercase hex characters.");
  atomicWriteJson(file, candidate);
  logStage("inbox", "out", { id: candidate.id, proposedBy: candidate.proposedBy });
}

export async function writeCandidate(home: string, candidate: Candidate): Promise<void> {
  await withLock(bankPaths(home).lock, () => writeCandidateHeld(home, candidate));
}

export function removeCandidate(home: string, id: string): void {
  const file = candidatePath(home, id);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
}

export function listDismissed(home: string): string[] {
  const file = bankPaths(home).dismissed;
  if (!fs.existsSync(file)) return [];
  const raw = readJson<{ ids?: string[] }>(file);
  return raw.ids ?? [];
}

export async function dismissCandidate(home: string, id: string): Promise<boolean> {
  return withLock(bankPaths(home).lock, () => {
    const candidate = readCandidate(home, id);
    if (!candidate) return false;
    const ids = new Set(listDismissed(home));
    ids.add(id);
    atomicWriteJson(bankPaths(home).dismissed, { schema: 1, ids: [...ids] });
    removeCandidate(home, id);
    logStage("inbox", "out", { dismissed: id });
    return true;
  });
}

export async function acceptCandidate(home: string, id: string): Promise<SaveOutcome | { ok: false; reason: "missing" }> {
  return withLock(bankPaths(home).lock, () => {
    const candidate = readCandidate(home, id);
    if (!candidate) return { ok: false, reason: "missing" };
    const taken = new Set(listEntries(home).map((entry) => entry.slug));
    const slug = freeSlug(candidate.draft.slug, taken);
    const outcome = saveEntryHeld(
      home,
      {
        slug,
        title: candidate.draft.title,
        language: candidate.draft.language,
        entryFile: candidate.draft.entryFile,
        symbols: candidate.draft.symbols,
        tags: candidate.draft.tags,
        intent: candidate.draft.intent,
        whenNot: candidate.draft.whenNot,
        deps: candidate.draft.deps,
        origin: candidate.draft.origin,
        ownership: candidate.draft.ownership,
      },
      candidate.files,
    );
    if (outcome.ok) removeCandidate(home, id);
    logStage("inbox", "out", { accepted: id, ok: outcome.ok });
    return outcome;
  });
}

function primaryExport(content: string): string | undefined {
  const visible = visibleSource(content);
  const declared = visible.match(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/);
  if (declared) return declared[1];
  const named = visible.match(/export\s*\{([^}]+)\}/);
  const first = named?.[1].split(",")[0]?.trim().split(/\s+as\s+/).pop()?.trim();
  if (first && /^[A-Za-z_$][\w$]*$/.test(first)) return first;
  return undefined;
}

export interface Proposal {
  title: string;
  intent: string;
  whenNot?: string;
  tags: string[];
  files: SourceFile[];
  deps?: { name: string; range: string }[];
}

export async function proposeCandidate(home: string, proposal: Proposal): Promise<{ ok: true; candidate: Candidate } | { ok: false; reason: string }> {
  if (!proposal.title.trim()) return { ok: false, reason: "A proposal needs a title." };
  if (proposal.intent.length > tuning.limits.text) return { ok: false, reason: "A proposal intent is over 280 characters." };
  if (proposal.whenNot && proposal.whenNot.length > tuning.limits.text) return { ok: false, reason: "A proposal when-not is over 280 characters." };
  if (proposal.tags.some((tag) => !tag.trim())) return { ok: false, reason: "A proposal tag is empty." };
  if (proposal.files.length === 0 || proposal.files.length > 20) return { ok: false, reason: "A proposal has 1 to 20 files." };
  const bytes = proposal.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (bytes > 200_000) return { ok: false, reason: "A proposal is larger than 200 KB." };
  const fileProblems = problemsForFiles(proposal.files);
  if (fileProblems.length > 0) {
    return { ok: false, reason: fileProblems.some((problem) => problem.startsWith("duplicate ")) ? "A proposal repeats a file path." : "A proposal path is not relative." };
  }
  for (const file of proposal.files) {
    try {
      assertSafeRelPath(file.relPath);
    } catch {
      return { ok: false, reason: "A proposal path is not relative." };
    }
  }
  const findings = scanSecrets(proposal.files.map((file) => file.content).join("\n")).filter((finding) => finding.severity === "block");
  if (findings.length > 0) return { ok: false, reason: "A proposal contains a secret." };
  const symbol = primaryExport(proposal.files[0].content);
  if (!symbol) return { ok: false, reason: "A proposal needs a named export." };
  if ((proposal.deps ?? []).some((dep) => !isPackageDep(dep))) return { ok: false, reason: "A proposal dependency is not a plain package range." };
  const id = createHash("sha256").update(`${proposal.title}\n${contentHash(proposal.files)}`).digest("hex").slice(0, 16);
  const candidate: Candidate = {
    schema: 1,
    id,
    draft: {
      schema: 1,
      slug: toSlug(proposal.title),
      title: proposal.title,
      version: 1,
      contentHash: contentHash(proposal.files),
      language: languageFromFile(proposal.files[0].relPath),
      entryFile: proposal.files[0].relPath,
      symbols: [symbol],
      tags: proposal.tags.map((tag) => tag.toLowerCase()).slice(0, 8),
      intent: proposal.intent,
      whenNot: proposal.whenNot,
      deps: proposal.deps ?? [],
      origin: {
        repoId: "agent",
        repoName: "agent",
        relPath: proposal.files[0].relPath,
        range: { startLine: 1, endLine: 1 },
        capturedBy: "agent",
      },
      ownership: "unknown",
    },
    files: proposal.files,
    score: 0.5,
    reasons: ["agent-proposed"],
    sources: [],
    proposedBy: "agent",
    createdAt: new Date().toISOString(),
  };
  await withLock(bankPaths(home).lock, () => {
    const taken = new Set([
      ...listEntries(home).map((entry) => entry.slug),
      ...listCandidates(home).map((item) => item.draft.slug),
    ]);
    candidate.draft.slug = freeSlug(candidate.draft.slug, taken);
    writeCandidateHeld(home, candidate);
  });
  return { ok: true, candidate };
}
