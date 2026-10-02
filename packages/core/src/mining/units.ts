export interface UnitSpan {
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  content: string;
}

const START =
  /(?:^|\n)([ \t]*)((?:export\s+)?)((?:async\s+)?function\s+[A-Za-z_$][\w$]*|(?:async\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>|const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?function\b|class\s+[A-Za-z_$][\w$]*)/g;

export function visibleSource(source: string): string {
  const hidden = lexicalMask(source);
  let text = "";
  for (let index = 0; index < source.length; index += 1) {
    text += hidden[index] ? " " : source[index] === "\n" ? "\n" : source[index];
  }
  return text;
}

function lexicalMask(source: string): Uint8Array {
  const hidden = new Uint8Array(source.length);
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        hidden[index] = 1;
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      hidden[index] = 1;
      hidden[index + 1] = 1;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        hidden[index] = 1;
        index += 1;
      }
      if (index < source.length) {
        hidden[index] = 1;
        hidden[index + 1] = 1;
        index += 2;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      hidden[index] = 1;
      index += 1;
      while (index < source.length) {
        hidden[index] = 1;
        if (source[index] === "\\") {
          index += 1;
          if (index < source.length) hidden[index] = 1;
          index += 1;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return hidden;
}

export function extractUnits(source: string): UnitSpan[] {
  const visible = visibleSource(source);
  const units: UnitSpan[] = [];
  for (const match of visible.matchAll(START)) {
    const at = match.index ?? 0;
    const header = match[0];
    const exported = /\bexport\b/.test(header);
    if (/\bconst\b/.test(header) && !exported) continue;
    const name = header.match(/(?:function|const|class)\s+([A-Za-z_$][\w$]*)/)?.[1];
    if (!name) continue;
    const located = statementEnd(source, at + header.length, header.includes("=>"));
    if (!located || ("expr" in located && !header.includes("=>"))) continue;
    const end = "body" in located ? matchingBrace(source, located.body) : located.expr;
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

function regexStart(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = source[cursor];
  if (previous === "<") return false;
  if ("([{:;,=~!&|?+-*%<>^".includes(previous)) return true;
  const word = source.slice(Math.max(0, cursor - 12), cursor + 1).match(/[A-Za-z_$][\w$]*$/)?.[0];
  return word === "return" || word === "typeof" || word === "case" || word === "throw" || word === "else" || word === "void" || word === "do" || word === "in" || word === "of" || word === "instanceof" || word === "delete" || word === "await" || word === "yield" || word === "new";
}

function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return index;
    if (char === "[" && !inClass) inClass = true;
    else if (char === "]" && inClass) inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

function lineNumber(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function statementEnd(source: string, from: number, arrow: boolean): { body: number } | { expr: number } | undefined {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let brace = 0;
  for (let index = from; index < source.length; ) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = source[index];
    if (char === "(") paren += 1;
    else if (char === ")" && paren > 0) paren -= 1;
    else if (char === "[") bracket += 1;
    else if (char === "]" && bracket > 0) bracket -= 1;
    else if (char === "<" && !arrow && paren === 0 && bracket === 0 && brace === 0) angle += 1;
    else if (char === ">" && !arrow && angle > 0 && paren === 0 && bracket === 0 && brace === 0 && source[index - 1] !== "=") angle -= 1;
    else if (char === "{") {
      if (paren === 0 && bracket === 0 && angle === 0 && brace === 0 && isBodyBrace(source, index, arrow)) return { body: index };
      brace += 1;
    } else if (char === "}" && brace > 0) brace -= 1;
    else if (char === ";" && paren === 0 && bracket === 0 && angle === 0 && brace === 0) return { expr: index };
    index += 1;
  }
  return undefined;
}

function isBodyBrace(source: string, index: number, arrow: boolean): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return false;
  const previous = source[cursor];
  if (previous === ">" ) return !arrow || source[cursor - 1] === "=";
  if (previous === ")" || previous === "}" || previous === "]") return true;
  return /[A-Za-z0-9_$]/.test(previous);
}

function skipNonCode(source: string, index: number): number {
  const char = source[index];
  const next = source[index + 1];
  if (char === "/" && next === "/") {
    let cursor = index + 2;
    while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
    return cursor;
  }
  if (char === "/" && next === "*") {
    let cursor = index + 2;
    while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) cursor += 1;
    return Math.min(source.length, cursor + 2);
  }
  if (char === "/" && next !== "/" && next !== "*" && regexStart(source, index)) return skipRegex(source, index);
  if (char === "'" || char === '"' || char === "`") {
    let cursor = index + 1;
    while (cursor < source.length) {
      const current = source[cursor];
      cursor += 1;
      if (current === "\\") {
        cursor += 1;
        continue;
      }
      if (current === char) break;
    }
    return cursor;
  }
  return index;
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
    if (char === "/" && next !== "/" && next !== "*" && regexStart(source, index)) {
      index = skipRegex(source, index);
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
