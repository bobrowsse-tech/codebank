export function normalize(source: string): string {
  let out = "";
  let index = 0;
  let pendingSpace = false;

  const markSpace = () => {
    if (out.length > 0) pendingSpace = true;
  };
  const flushSpace = () => {
    if (pendingSpace && out.length > 0 && !out.endsWith(" ")) out += " ";
    pendingSpace = false;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      markSpace();
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(source.length, index + 2);
      markSpace();
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      flushSpace();
      const quote = char;
      out += quote;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        out += current;
        index += 1;
        if (current === "\\") {
          if (index < source.length) {
            out += source[index];
            index += 1;
          }
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    if (/\s/.test(char)) {
      markSpace();
      index += 1;
      continue;
    }
    flushSpace();
    out += char;
    index += 1;
  }
  return out.trim();
}
