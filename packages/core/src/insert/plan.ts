import fs from "node:fs";
import path from "node:path";
import { logStage } from "../log";
import type { Entry, Language, SourceFile } from "../model/types";
import { isPackageDep } from "../model/validate";
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
  fromFile?: string;
  projectDir?: string;
  insertDir?: string;
  lineage?: "marker" | "external";
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
  const importLine = input.mode === "add" ? importFrom(input, symbol) : undefined;
  const plan: InsertPlan = {
    slug: input.entry.slug,
    version: input.entry.version,
    mode: input.mode,
    files: input.files.map((file) => {
      const start = markerLine(input.entry.language, input.entry.slug, input.entry.version, input.entry.contentHash, file.relPath);
      const end = endMarkerLine(input.entry.language, file.relPath);
      return {
        relPath: file.relPath,
        content: input.lineage === "external" ? file.content : input.mode === "cursor" ? `${start}\n${file.content}\n${end}` : `${start}\n${file.content}`,
      };
    }),
    importLine,
    missingDeps,
    installCommand: installCommand(missingDeps),
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
  for (const file of plan.files) {
    const rel = [insertDir, plan.slug, file.relPath].join("/");
    const target = resolveInside(projectDir, rel);
    atomicWrite(target, file.content);
    written.push(target);
  }
  logStage("insert", "out", { wrote: written.length });
  return written;
}

export function markerLine(language: Language, slug: string, version: number, hash: string, filePath?: string): string {
  return commentFor(language, `@codebank ${slug} v${version} ${hash}`, filePath);
}

function installCommand(deps: { name: string; range: string }[]): string | undefined {
  const safe = deps.filter((dep) => isPackageDep(dep));
  if (safe.length === 0) return undefined;
  return `npm install ${safe.map((dep) => `'${dep.name}@${dep.range}'`).join(" ")}`;
}

export function endMarkerLine(language: Language, filePath?: string): string {
  return commentFor(language, "@codebank-end", filePath);
}

function commentFor(language: Language, text: string, filePath?: string): string {
  const ext = filePath ? path.extname(filePath).toLowerCase() : "";
  if (ext === ".html" || ext === ".htm") return `<!-- ${text} -->`;
  if (ext === ".css" || ext === ".scss") return `/* ${text} */`;
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") return `// ${text}`;
  if (language === "css" || language === "scss") return `/* ${text} */`;
  if (language === "other") return `# ${text}`;
  return `// ${text}`;
}

function importFrom(input: { entry: Entry; fromFile?: string; projectDir?: string; insertDir?: string }, symbol: string): string | undefined {
  if (!input.fromFile || !input.projectDir || !input.insertDir) return undefined;
  const dest = path.join(input.projectDir, input.insertDir, input.entry.slug, stripExt(input.entry.entryFile));
  let rel = path.relative(path.dirname(input.fromFile), dest);
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return `import { ${symbol} } from '${rel}';`;
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
