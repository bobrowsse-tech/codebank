import * as vscode from "vscode";
import { heuristicClosure, languageFromFile, type ClosureResult, type SourceFile } from "../../core/src/index.ts";

const KEYWORDS = new Set(["const", "let", "var", "function", "class", "return", "if", "else", "import", "export", "from", "new", "type", "interface", "async", "await"]);

export async function closeSelection(document: vscode.TextDocument, selection: vscode.Selection): Promise<ClosureResult> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    document.uri,
  );
  if (!symbols) {
    const alone = selectionText(document, selection);
    return {
      files: [{ relPath: workspaceRel(document.uri), content: alone }],
      deps: [],
      warnings: ["closure unavailable"],
      truncated: false,
      language: languageFromFile(document.fileName),
      symbols: [],
      entryFile: workspaceRel(document.uri),
    };
  }
  const expanded = enclosingSymbol(symbols, selection) ?? selection;
  const files = new Map<string, SourceFile>();
  const warnings: string[] = [];
  let truncated = false;
  const queue: { uri: vscode.Uri; range: vscode.Range; depth: number }[] = [
    { uri: document.uri, range: toRange(expanded), depth: 0 },
  ];
  const seen = new Set<string>();
  while (queue.length > 0 && files.size < 30) {
    const current = queue.shift();
    if (!current) break;
    const key = `${current.uri.toString()}:${current.range.start.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = await vscode.workspace.openTextDocument(current.uri);
    if (doc.uri.scheme !== "file" || doc.fileName.includes("node_modules") || doc.fileName.endsWith(".d.ts")) continue;
    const text = doc.getText(current.range);
    const rel = workspaceRel(doc.uri);
    files.set(rel, { relPath: rel, content: text });
    if (byteSize(files) > 60_000) {
      truncated = true;
      warnings.push("Closure stopped at 60 KB.");
      break;
    }
    if (current.depth >= 3) continue;
    for (const name of freeIdentifiers(text)) {
      const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        "vscode.executeDefinitionProvider",
        doc.uri,
        positionOf(doc, current.range, name),
      );
      const target = firstLocation(defs);
      if (!target) continue;
      const folder = vscode.workspace.getWorkspaceFolder(target.uri);
      if (!folder || target.uri.fsPath.includes("node_modules") || target.uri.fsPath.endsWith(".d.ts")) continue;
      const targetDoc = await vscode.workspace.openTextDocument(target.uri);
      const targetSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        target.uri,
      );
      const around = enclosingSymbol(targetSymbols ?? [], new vscode.Selection(target.range.start, target.range.end)) ?? target.range;
      queue.push({ uri: target.uri, range: toRange(around), depth: current.depth + 1 });
    }
  }
  if (files.size === 0) {
    return heuristicClosure(document.fileName, { startLine: selection.start.line + 1, endLine: selection.end.line + 1 });
  }
  const primary = workspaceRel(document.uri);
  const heuristic = heuristicClosure(document.fileName);
  return {
    files: [...files.values()],
    deps: heuristic.deps,
    warnings,
    truncated,
    language: languageFromFile(document.fileName),
    symbols: heuristic.symbols,
    entryFile: files.has(primary) ? primary : [...files.keys()][0],
  };
}

function enclosingSymbol(symbols: vscode.DocumentSymbol[], selection: vscode.Selection | vscode.Range): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    const nested = enclosingSymbol(symbol.children, selection);
    if (nested) return nested;
    if (symbol.range.contains(selection)) return symbol;
  }
  return undefined;
}

function toRange(value: vscode.DocumentSymbol | vscode.Range | vscode.Selection): vscode.Range {
  if (value instanceof vscode.Range || value instanceof vscode.Selection) return value;
  return value.range;
}

function freeIdentifiers(source: string): string[] {
  const declared = new Set<string>();
  for (const match of source.matchAll(/\b(?:function|class|const|let|var|type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1]) declared.add(match[1]);
  }
  const names = new Set<string>();
  for (const match of source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const name = match[0];
    if (!KEYWORDS.has(name) && !declared.has(name)) names.add(name);
  }
  return [...names];
}

function positionOf(document: vscode.TextDocument, range: vscode.Range, name: string): vscode.Position {
  const text = document.getText(range);
  const index = text.indexOf(name);
  if (index < 0) return range.start;
  return document.positionAt(document.offsetAt(range.start) + index);
}

function firstLocation(defs: Array<vscode.Location | vscode.LocationLink> | undefined): vscode.Location | undefined {
  const first = defs?.[0];
  if (!first) return undefined;
  if ("targetUri" in first) return new vscode.Location(first.targetUri, first.targetRange);
  return first;
}

function workspaceRel(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? vscode.workspace.asRelativePath(uri, false) : uri.path.split("/").pop() ?? uri.path;
}

function selectionText(document: vscode.TextDocument, selection: vscode.Selection): string {
  return document.getText(selection);
}

function byteSize(files: Map<string, SourceFile>): number {
  return [...files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
}
