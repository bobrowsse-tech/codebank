const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for",
  "with", "from", "by", "at", "as", "is", "it", "be", "this", "that",
  "these", "those", "into", "over", "under", "not", "no", "yes", "if", "then",
  "else", "when", "use", "using", "used", "via", "per", "its", "your", "you",
]);

export function tokenize(input: string): string[] {
  const spaced = input.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./]+/g, " ");
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP.has(token));
}

export function trigrams(input: string): Set<string> {
  const padded = `  ${input.toLowerCase()}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}
