export function uniqueRows<T>(rows: T[]): T[] {
  return rows.filter((row, index) => rows.indexOf(row) === index);
}
