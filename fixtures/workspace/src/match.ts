import { normalizeText } from "./normalize";

export function matches(row: unknown, query: string): boolean {
  return normalizeText(String(row)).includes(query);
}
