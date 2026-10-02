import { tuning } from "../tuning";
import type { BankConfig, Candidate, Entry, Language, Origin, SourceFile } from "./types";
import { SchemaError } from "./types";

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PACKAGE_RANGE = /^(?:\*|(?:[\^~]|>=|<=|>|<)?(?:\d+(?:\.\d+){0,2}(?:\.x)?|\d+\.x(?:\.x)?)(?:-[0-9A-Za-z.-]+)?)$/;

export function isPackageDep(dep: { name: string; range: string }): boolean {
  return PACKAGE_NAME.test(dep.name) && PACKAGE_RANGE.test(dep.range);
}
const LANGUAGES = new Set<Language>(["ts", "tsx", "js", "jsx", "css", "scss", "other"]);

export function requireSchema(value: unknown, label: string): { schema: number } {
  if (!value || typeof value !== "object" || !("schema" in value)) {
    throw new SchemaError(`${label} has no schema. Codebank will not guess.`);
  }
  const schema = (value as { schema: unknown }).schema;
  if (schema !== 1) {
    if (typeof schema === "number" && schema > 1) {
      throw new SchemaError(`${label} uses schema ${schema}. Update Codebank to read it.`);
    }
    throw new SchemaError(`${label} has schema ${String(schema)}. Codebank reads schema 1.`);
  }
  return value as { schema: number };
}

export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

export function toSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, tuning.limits.slug);
  return isSlug(slug) ? slug : "entry";
}

export function problemsForEntry(entry: Entry): string[] {
  const problems: string[] = [];
  if (entry.schema !== 1) problems.push("schema must be 1");
  if (!isSlug(entry.slug)) problems.push("slug is not kebab-case within 48 characters");
  if (!entry.title.trim()) problems.push("title is empty");
  if (!Number.isInteger(entry.version) || entry.version < 1) problems.push("version must be an integer starting at 1");
  if (!/^[a-f0-9]{12}$/.test(entry.contentHash)) problems.push("contentHash must be 12 hex characters");
  if (!LANGUAGES.has(entry.language)) problems.push("language is not supported");
  if (!safeRel(entry.entryFile)) problems.push("entryFile is not a relative path");
  if (entry.tags.length > tuning.limits.tags) problems.push("at most 8 tags");
  if (entry.tags.some((tag) => tag !== tag.toLowerCase() || !tag.trim())) problems.push("tags are lowercase");
  if (entry.intent.length > tuning.limits.text) problems.push("intent is over 280 characters");
  if (entry.whenNot && entry.whenNot.length > tuning.limits.text) problems.push("whenNot is over 280 characters");
  if (!["personal", "client", "unknown"].includes(entry.ownership)) problems.push("ownership is invalid");
  if (!["active", "stale", "retired"].includes(entry.status)) problems.push("status is invalid");
  problems.push(...problemsForOrigin(entry.origin));
  return problems;
}

export function problemsForOrigin(origin: Origin): string[] {
  const problems: string[] = [];
  if (!origin.repoId || !origin.repoName || !safeRel(origin.relPath)) problems.push("origin is incomplete");
  if (!Number.isInteger(origin.range.startLine) || !Number.isInteger(origin.range.endLine)) problems.push("origin range is invalid");
  if (origin.range.endLine < origin.range.startLine) problems.push("origin range is reversed");
  return problems;
}

export function problemsForFiles(files: SourceFile[]): string[] {
  return files.flatMap((file) => (safeRel(file.relPath) ? [] : [`rejected path ${file.relPath}`]));
}

export function problemsForCandidate(candidate: Candidate): string[] {
  const problems: string[] = [];
  if (candidate.schema !== 1) problems.push("schema must be 1");
  if (!candidate.id.trim()) problems.push("id is empty");
  if (candidate.score < 0 || candidate.score > 1) problems.push("score must be from 0 to 1");
  problems.push(...problemsForFiles(candidate.files));
  return problems;
}

export function defaultConfig(): BankConfig {
  return {
    schema: 1,
    scan: {
      roots: ["~/code"],
      ignore: ["node_modules", ".git", "dist", "build", ".next"],
      maxFileKB: 200,
    },
    orgs: { client: [], personal: [] },
    lineage: { mode: "marker", externalForClient: true },
    recall: { enabled: true, threshold: 0.72, cooldownMinutes: 10 },
    model: { consented: false, family: null },
  };
}

export function parseConfig(value: unknown, label: string): BankConfig {
  requireSchema(value, label);
  const raw = value as Partial<BankConfig>;
  const base = defaultConfig();
  return {
    schema: 1,
    scan: { ...base.scan, ...raw.scan },
    orgs: {
      client: raw.orgs?.client ?? [],
      personal: raw.orgs?.personal ?? [],
    },
    lineage: { ...base.lineage, ...raw.lineage },
    recall: { ...base.recall, ...raw.recall },
    model: { ...base.model, ...raw.model },
  };
}

function safeRel(rel: string): boolean {
  if (!rel || pathIsAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes("..");
}

function pathIsAbsolute(rel: string): boolean {
  return rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel);
}
