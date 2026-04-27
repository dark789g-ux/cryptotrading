export function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

export function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatTradeDateLabel(value: string): string {
  if (value.length !== 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function formatChinaDate(date: Date): string {
  const utcMs = date.getTime() + 8 * 60 * 60 * 1000;
  const china = new Date(utcMs);
  const year = china.getUTCFullYear();
  const month = String(china.getUTCMonth() + 1).padStart(2, '0');
  const day = String(china.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
