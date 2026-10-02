export function filterRows<T>(rows: T[], text: string): T[] {
  const query = text.trim().toLowerCase();
  return rows.filter((row) => String(row).toLowerCase().includes(query));
}
