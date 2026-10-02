import { escapeRegExp } from "lodash";

export function normalizeText(value: string): string {
  return escapeRegExp(value.trim().toLowerCase());
}
