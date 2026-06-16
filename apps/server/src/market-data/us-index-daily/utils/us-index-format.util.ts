export function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** `YYYYMMDD` → `YYYY-MM-DD`（K 线副图对齐 key 用，见 datetime.md）。 */
export function formatTradeDateLabel(value: string): string {
  if (value.length !== 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
