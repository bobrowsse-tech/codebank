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
  const bare = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.abs)) continue;
    seen.add(current.abs);
    if (!fs.existsSync(current.abs) || !fs.statSync(current.abs).isFile()) continue;
    const raw = fs.readFileSync(current.abs, "utf8");
    const saved = current.rel === entryRel && range ? sliceLines(raw, range) : raw;
    const content = limitFile(saved, warnings, current.rel);
    files.push({ relPath: current.rel, content });
    for (const name of bareSpecifiers(raw)) bare.add(name);
    const specifiers = relativeSpecifiers(raw);
    if (current.depth >= tuning.closure.maxDepth) {
      if (specifiers.length > 0) truncated = true;
      continue;
    }
    for (const specifier of specifiers) {
      const resolved = resolveRelative(path.dirname(current.abs), specifier);
      if (!resolved) {
        warnings.push(`import '${specifier}' in ${current.rel} was not included`);
        continue;
      }
      queue.push({ abs: resolved, rel: normalizeRel(path.relative(root, resolved)), depth: current.depth + 1 });
    }
  }

  const deps = packageDeps(path.resolve(filePath), bare);
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

function packageDeps(startFile: string, names: Set<string>): { name: string; range: string }[] {
  const manifest = nearestPackageJson(path.dirname(startFile));
  const declared = readDependencyRanges(manifest);
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

export function withRequiredImports(source: string, slice: string): string {
  const needed = importStatements(source).filter((statement) => {
    if (slice.includes(statement)) return false;
    return importedNames(statement).some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(slice));
  });
  if (needed.length === 0) return slice;
  return `${needed.join("\n")}\n${slice}`;
}

function importStatements(source: string): string[] {
  const statements: string[] = [];
  const pattern = /(?:^|\n)\s*(import\s*['"][^'"]+['"]\s*;?|import\s[\s\S]*?from\s*['"][^'"]+['"]\s*;?|(?:const|let|var)\s+[^;\n]*require\(\s*['"][^'"]+['"]\s*\)\s*;?)/g;
  for (const match of source.matchAll(pattern)) {
    const statement = match[1]?.trim();
    if (statement) statements.push(statement);
  }
  return statements;
}

function importedNames(statement: string): string[] {
  const names: string[] = [];
  const named = statement.match(/\{([^}]+)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = piece.replace(/^type\s+/, "").split(/\s+as\s+/);
      names.push((alias[1] ?? alias[0]).trim());
    }
  }
  const star = statement.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (star?.[1]) names.push(star[1]);
  const typedDefault = statement.match(/import\s+type\s+([A-Za-z_$][\w$]*)\s+from/);
  if (typedDefault?.[1]) names.push(typedDefault[1]);
  const def = statement.match(/import\s+(?!type\b)([A-Za-z_$][\w$]*)\s*(?:,|from)/);
  if (def?.[1]) names.push(def[1]);
  const required = statement.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require/);
  if (required?.[1]) names.push(required[1]);
  return names.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
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
