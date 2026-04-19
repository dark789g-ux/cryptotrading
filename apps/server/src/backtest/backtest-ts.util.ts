/** 与 K 线 open_time / 前端 ts 字符串互转（UTC） */

export function fmtTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export function parseUTC(raw?: string): Date | null {
  if (!raw?.trim()) return null;
  const s = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(s.endsWith('Z') ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
