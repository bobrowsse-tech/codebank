import { matches } from "./match";

export function filterRows<T>(rows: T[], text: string): T[] {
  const query = text.trim().toLowerCase();
  return rows.filter((row) => matches(row, query));
}
