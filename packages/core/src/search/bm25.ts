import { tuning } from "../tuning";

export interface Bm25Field {
  weight: number;
  tokens: string[];
}

export interface Bm25Document {
  id: string;
  fields: Bm25Field[];
}

export function scoreBm25(documents: Bm25Document[], queryTokens: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (queryTokens.length === 0 || documents.length === 0) return scores;

  const avgLength = documents.reduce((sum, doc) => sum + docLength(doc), 0) / documents.length;
  const docCount = documents.length;
  for (const doc of documents) {
    let score = 0;
    for (const field of doc.fields) {
      const length = Math.max(field.tokens.length, 1);
      for (const token of queryTokens) {
        const freq = field.tokens.filter((item) => item === token).length;
        if (freq === 0) continue;
        const docsWithTerm = documents.filter((candidate) =>
          candidate.fields.some((item) => item.tokens.includes(token)),
        ).length;
        const idf = Math.log(1 + (docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
        const { k1, b } = tuning.bm25;
        const denom = freq + k1 * (1 - b + (b * length) / Math.max(avgLength, 1));
        score += field.weight * idf * ((freq * (k1 + 1)) / denom);
      }
    }
    scores.set(doc.id, score);
  }
  return scores;
}

function docLength(doc: Bm25Document): number {
  return doc.fields.reduce((sum, field) => sum + field.tokens.length, 0);
}
