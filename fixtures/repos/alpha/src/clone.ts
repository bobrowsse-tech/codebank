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

export function formatInvoice(cents: number, currency: string): string {
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const padded = String(fraction).padStart(2, "0");
  const label = currency.toUpperCase();
  const body = `${label} ${whole}.${padded}`;
  return body;
}
