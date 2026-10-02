export interface UnitSpan {
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  content: string;
}

const START =
  /(?:^|\n)([ \t]*)((?:export\s+)?)((?:async\s+)?function\s+[A-Za-z_$][\w$]*|(?:async\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>|class\s+[A-Za-z_$][\w$]*)/g;

export function extractUnits(source: string): UnitSpan[] {
  const units: UnitSpan[] = [];
  for (const match of source.matchAll(START)) {
    const at = match.index ?? 0;
    const header = match[0];
    const exported = /\bexport\b/.test(header);
    if (/\bconst\b/.test(header) && !exported) continue;
    const name = header.match(/(?:function|const|class)\s+([A-Za-z_$][\w$]*)/)?.[1];
    if (!name) continue;
    const braceAt = findBrace(source, at + header.length);
    if (braceAt < 0) continue;
    const end = matchingBrace(source, braceAt);
    if (end < 0) continue;
    const start = source[at] === "\n" ? at + 1 : at;
    const startLine = lineNumber(source, start);
    const endLine = lineNumber(source, end);
    const lines = endLine - startLine + 1;
    if (lines < 8 || lines > 200) continue;
    units.push({ name, exported, startLine, endLine, content: source.slice(start, end + 1) });
  }
  return units;
}

function lineNumber(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function findBrace(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "{") return index;
    if (source[index] === ";") return -1;
  }
  return -1;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        index += 1;
        if (current === "\\") {
          index += 1;
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}
