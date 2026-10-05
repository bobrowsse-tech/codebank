export function filterRows<T>(rows: T[], text: string): T[] {
  const query = text.trim().toLowerCase();
  const matched: T[] = [];
  for (const row of rows) {
    const value = String(row).toLowerCase();
    if (value.includes(query)) {
      matched.push(row);
    }
  }
  return matched;
}
