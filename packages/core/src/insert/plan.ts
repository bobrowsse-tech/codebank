import fs from "node:fs";
import path from "node:path";
import { logStage } from "../log";
import type { Entry, Language, SourceFile } from "../model/types";
import { crossOrgBlocked } from "../security/ownership";
import { atomicWrite } from "../store/atomic";
import { resolveInside } from "../store/paths";

export interface InsertPlan {
  slug: string;
  version: number;
  mode: "add" | "cursor";
  files: SourceFile[];
  importLine?: string;
  missingDeps: { name: string; range: string }[];
  installCommand?: string;
  adapt: boolean;
  adaptHint?: string;
  blocked?: "cross-org";
  verbatim: boolean;
}

export function planInsert(input: {
  entry: Entry;
  files: SourceFile[];
  mode: "add" | "cursor";
  targetLanguage: Language;
  targetPackageJson?: string;
  targetOrg?: string;
  confirmedCrossOrg?: boolean;
  symbol?: string;
}): InsertPlan {
  logStage("insert", "in", { slug: input.entry.slug, mode: input.mode });
  const blocked = crossOrgBlocked(input.entry.ownership, input.entry.origin.org, input.targetOrg) && !input.confirmedCrossOrg;
  const installed = readInstalled(input.targetPackageJson);
  const missingDeps = input.entry.deps.filter((dep) => !installed.has(dep.name));
  const majorMismatch = input.entry.deps.some((dep) => {
    const have = installed.get(dep.name);
    return have !== undefined && major(have) !== major(dep.range);
  });
  const languageMatches = input.entry.language === input.targetLanguage;
  const verbatim = languageMatches && !majorMismatch && missingDeps.length === 0;
  const symbol = input.symbol || input.entry.symbols[0] || input.entry.title;
  const importLine = input.mode === "add" ? `import { ${symbol} } from './${input.entry.slug}/${stripExt(input.entry.entryFile)}';` : undefined;
  const plan: InsertPlan = {
    slug: input.entry.slug,
    version: input.entry.version,
    mode: input.mode,
    files: input.files.map((file) => ({
      relPath: file.relPath,
      content: `${markerLine(input.entry.language, input.entry.slug, input.entry.version, input.entry.contentHash)}\n${file.content}`,
    })),
    importLine,
    missingDeps,
    installCommand: missingDeps.length > 0 ? `npm install ${missingDeps.map((dep) => `${dep.name}@${dep.range}`).join(" ")}` : undefined,
    adapt: !verbatim,
    adaptHint: verbatim ? undefined : adaptHint(languageMatches, majorMismatch, missingDeps),
    blocked: blocked ? "cross-org" : undefined,
    verbatim,
  };
  logStage("insert", "out", { verbatim, missing: missingDeps.map((dep) => dep.name), blocked: plan.blocked });
  return plan;
}

export function applyInsert(projectDir: string, insertDir: string, plan: InsertPlan): string[] {
  if (plan.blocked) throw new Error("Cross-org insert is waiting for confirmation.");
  const written: string[] = [];
  const root = path.join(projectDir, insertDir, plan.slug);
  for (const file of plan.files) {
    const target = resolveInside(root, file.relPath);
    atomicWrite(target, file.content);
    written.push(target);
  }
  logStage("insert", "out", { wrote: written.length });
  return written;
}

export function markerLine(language: Language, slug: string, version: number, hash: string): string {
  const text = `@codebank ${slug} v${version} ${hash}`;
  if (language === "css" || language === "scss") return `/* ${text} */`;
  if (language === "other") return `# ${text}`;
  return `// ${text}`;
}

function adaptHint(languageMatches: boolean, majorMismatch: boolean, missing: { name: string }[]): string {
  const parts: string[] = [];
  if (!languageMatches) parts.push("the target language differs");
  if (majorMismatch) parts.push("a dependency major version differs");
  if (missing.length > 0) parts.push(`missing ${missing.map((dep) => dep.name).join(", ")}`);
  return `Adapt the copy: ${parts.join("; ")}.`;
}

function readInstalled(packageJson?: string): Map<string, string> {
  const installed = new Map<string, string>();
  if (!packageJson || !fs.existsSync(packageJson)) return installed;
  const json = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const [name, range] of Object.entries({ ...json.devDependencies, ...json.dependencies })) installed.set(name, range);
  return installed;
}

function major(range: string): string {
  const match = range.match(/\d+/);
  return match?.[0] ?? range;
}

function stripExt(rel: string): string {
  return rel.replace(/\.(tsx|ts|jsx|js)$/, "");
}
