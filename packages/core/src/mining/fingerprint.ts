export function fingerprintText(source: string): string {
  let out = "";
  let index = 0;
  let pendingSpace = false;
  const mark = () => {
    if (out.length > 0) pendingSpace = true;
  };
  const flush = () => {
    if (pendingSpace && out.length > 0 && !out.endsWith(" ")) out += " ";
    pendingSpace = false;
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      mark();
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(source.length, index + 2);
      mark();
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      flush();
      out += "STR";
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
    if (/[0-9]/.test(char)) {
      flush();
      out += "0";
      index += 1;
      while (index < source.length && /[0-9.]/.test(source[index])) index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      mark();
      index += 1;
      continue;
    }
    flush();
    out += char;
    index += 1;
  }
  return out.trim();
}

export function shingles(source: string, width = 5): Set<string> {
  const tokens = fingerprintText(source).split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  if (tokens.length === 0) return grams;
  if (tokens.length < width) {
    grams.add(tokens.join(" "));
    return grams;
  }
  for (let i = 0; i <= tokens.length - width; i += 1) grams.add(tokens.slice(i, i + width).join(" "));
  return grams;
}

export function shingleJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  const [small, large] = left.size < right.size ? [left, right] : [right, left];
  for (const gram of small) if (large.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

const PERMUTATIONS = 64;

export function minhash(grams: Set<string>): Uint32Array {
  const signature = new Uint32Array(PERMUTATIONS);
  signature.fill(0xffffffff);
  for (const gram of grams) {
    for (let i = 0; i < PERMUTATIONS; i += 1) {
      const hashed = mix(gram, i + 1);
      if (hashed < signature[i]) signature[i] = hashed;
    }
  }
  return signature;
}

export function bandKey(signature: Uint32Array, band: number): string {
  const start = band * 4;
  return `${signature[start]},${signature[start + 1]},${signature[start + 2]},${signature[start + 3]}`;
}

function mix(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
