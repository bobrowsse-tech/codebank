import fs from "node:fs";
import path from "node:path";
import { logStage } from "../log";
import type { Language, SourceFile } from "../model/types";
import { tuning } from "../tuning";

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export interface ClosureResult {
  files: SourceFile[];
  deps: { name: string; range: string }[];
  warnings: string[];
  truncated: boolean;
  language: Language;
  symbols: string[];
  entryFile: string;
}

export function heuristicClosure(filePath: string, range?: { startLine: number; endLine: number }): ClosureResult {
  logStage("closure", "in", { filePath, range });
  const absStart = path.resolve(filePath);
  const manifest = nearestPackageJson(path.dirname(absStart));
  const root = manifest ? path.dirname(manifest) : path.dirname(absStart);
  const entryRel = normalizeRel(path.relative(root, absStart));
  const warnings: string[] = [];
  const files: SourceFile[] = [];
  const seen = new Set<string>();
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: absStart, rel: entryRel, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.abs)) continue;
    seen.add(current.abs);
    if (!fs.existsSync(current.abs) || !fs.statSync(current.abs).isFile()) continue;
    const raw = fs.readFileSync(current.abs, "utf8");
    const sliced = current.rel === entryRel && range ? sliceLines(raw, range) : raw;
    const content = limitFile(sliced, warnings, current.rel);
    files.push({ relPath: current.rel, content });
    if (current.depth >= tuning.closure.maxDepth) continue;
    for (const specifier of relativeSpecifiers(content)) {
      const resolved = resolveRelative(path.dirname(current.abs), specifier);
      if (!resolved) {
        warnings.push(`import '${specifier}' in ${current.rel} was not included`);
        continue;
      }
      queue.push({ abs: resolved, rel: normalizeRel(path.relative(root, resolved)), depth: current.depth + 1 });
    }
  }

  const deps = packageDeps(path.resolve(filePath), files);
  const entry = files[0];
  const result: ClosureResult = {
    files,
    deps,
    warnings,
    truncated,
    language: languageFromFile(filePath),
    symbols: exportedSymbols(entry?.content ?? ""),
    entryFile: entry?.relPath ?? entryRel,
  };
  void truncated;
  logStage("closure", "out", { files: result.files.length, deps: result.deps.map((dep) => dep.name), warnings: warnings.length });
  return result;
}

function relativeSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] || match[2];
    if (specifier) found.add(specifier);
  }
  return [...found];
}

function bareSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:from|import)\s*\(?\s*['"]([^.'"][^'"]*)['"]|require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] || match[2];
    if (!specifier || specifier.startsWith(".")) continue;
    found.add(packageName(specifier));
  }
  return [...found].filter((name) => !name.startsWith("@types/"));
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}

function resolveRelative(fromDir: string, specifier: string): string | undefined {
  const base = path.resolve(fromDir, specifier);
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function packageDeps(startFile: string, files: SourceFile[]): { name: string; range: string }[] {
  const manifest = nearestPackageJson(path.dirname(startFile));
  const declared = readDependencyRanges(manifest);
  const names = new Set<string>();
  for (const file of files) for (const name of bareSpecifiers(file.content)) names.add(name);
  return [...names].map((name) => ({ name, range: declared.get(name) ?? "*" }));
}

function nearestPackageJson(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readDependencyRanges(manifest: string | undefined): Map<string, string> {
  const ranges = new Map<string, string>();
  if (!manifest) return ranges;
  const json = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const [name, range] of Object.entries(json.dependencies ?? {})) ranges.set(name, range);
  for (const [name, range] of Object.entries(json.devDependencies ?? {})) {
    if (!ranges.has(name)) ranges.set(name, range);
  }
  return ranges;
}

function limitFile(source: string, warnings: string[], rel: string): string {
  const lines = source.split("\n");
  if (lines.length <= tuning.closure.maxWholeFileLines) return source;
  warnings.push(`${rel} is over 200 lines; only the opening section and its imports were kept`);
  const imports = lines.filter((line) => /^\s*import\b/.test(line) || /^\s*export\s+.*\sfrom\b/.test(line));
  return [...imports, ...lines.slice(0, tuning.closure.maxWholeFileLines)].join("\n");
}

function sliceLines(source: string, range: { startLine: number; endLine: number }): string {
  const lines = source.split("\n");
  return lines.slice(Math.max(0, range.startLine - 1), range.endLine).join("\n");
}

function exportedSymbols(source: string): string[] {
  const names = new Set<string>();
  const pattern = /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+([A-Za-z0-9_]+)/g;
  for (const match of source.matchAll(pattern)) if (match[1]) names.add(match[1]);
  return [...names];
}

export function languageFromFile(filePath: string): Language {
  const ext = path.extname(filePath);
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".css" || ext === ".scss") {
    return ext.slice(1) as Language;
  }
  return "other";
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/");
}
