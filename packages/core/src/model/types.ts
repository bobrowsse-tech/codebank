export type Slug = string;

export type Language = "ts" | "tsx" | "js" | "jsx" | "css" | "scss" | "other";

export interface Origin {
  repoId: string;
  repoName: string;
  remote?: string;
  org?: string;
  commit?: string;
  relPath: string;
  range: { startLine: number; endLine: number };
  capturedBy: "manual" | "mining" | "agent";
}

export interface Entry {
  schema: 1;
  slug: Slug;
  title: string;
  version: number;
  contentHash: string;
  language: Language;
  entryFile: string;
  symbols: string[];
  tags: string[];
  intent: string;
  whenNot?: string;
  deps: { name: string; range: string }[];
  origin: Origin;
  ownership: "personal" | "client" | "unknown";
  createdAt: string;
  updatedAt: string;
  stats: { uses: number; verbatimInserts: number; lastUsedAt?: string };
  status: "active" | "stale" | "retired";
  staleReason?: string;
  variantOf?: { slug: Slug; version: number };
  secretOverrides?: string[];
}

export interface Candidate {
  schema: 1;
  id: string;
  draft: Omit<Entry, "stats" | "createdAt" | "updatedAt" | "status">;
  files: { relPath: string; content: string }[];
  score: number;
  reasons: string[];
  sources: Origin[];
  proposedBy: "mining" | "agent" | "duplicate";
  createdAt: string;
}

export interface Link {
  slug: Slug;
  version: number;
  baseHash: string;
  repoId: string;
  relPath: string;
  sourceRelPath?: string;
  mode: "marker" | "external";
  localHash: string;
  insertedAt: string;
}

export interface UsageEvent {
  t: string;
  kind: "search" | "shown" | "inserted" | "dismissed" | "edited-after" | "promoted" | "update-applied";
  surface: "quickpick" | "codelens" | "chat" | "cli" | "mcp";
  slug?: Slug;
  query?: string;
  verbatim?: boolean;
}

export interface Card {
  slug: Slug;
  title: string;
  intent: string;
  whenNot?: string;
  language: Language;
  tags: string[];
  deps: string[];
  lines: number;
  version: number;
  uses: number;
  lastUsedAt?: string;
  status: Entry["status"];
  ownership: Entry["ownership"];
  origin: string;
}

export interface BankConfig {
  schema: 1;
  scan: { roots: string[]; ignore: string[]; maxFileKB: number };
  orgs: { client: string[]; personal: string[] };
  lineage: { mode: "marker" | "external"; externalForClient: boolean };
  recall: { enabled: boolean; threshold: number; cooldownMinutes: number };
  model: { consented: boolean; family: string | null };
}

export interface SourceFile {
  relPath: string;
  content: string;
}

export class SchemaError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}
