/**
 * 后端 numeric 字段格式化工具。
 *
 * 背景：PostgreSQL numeric 列经 node-postgres 默认返回 string，
 * 即使后端加了 ValueTransformer，仍可能存在某接口路径漏接导致前端拿到 string。
 * 本工具统一防御性兼容 number/string/null/undefined/NaN/Infinity 入参，
 * 配合 Number.isFinite 做严格 number 校验后再格式化。
 */

/**
 * 把后端返回的 numeric 字段（可能为 number / string / null）安全转为 number。
 * - null / undefined / 空字符串 → null
 * - 非数字字符串（如 "abc"）→ null
 * - NaN / Infinity / -Infinity → null
 * - 其他 → 解析后的 number
 */
export function toNum(
  v: number | string | null | undefined,
): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 百分比格式化。
 * @param v 入参（number / 字符串 numeric / null）
 * @param digits 小数位数，默认 2
 * @returns 如 "55.13%"；入参无效时返回 "-"
 *
 * 示例：
 *   fmtPct(0.5513)      → "55.13%"
 *   fmtPct("0.5513")    → "55.13%"
 *   fmtPct(-0.235)      → "-23.50%"
 *   fmtPct(null)        → "-"
 *   fmtPct("abc")       → "-"
 */
export function fmtPct(
  v: number | string | null | undefined,
  digits = 2,
): string {
  const n = toNum(v);
  if (n === null) return '-';
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * 数字格式化。
 * @param v 入参（number / 字符串 numeric / null）
 * @param digits 小数位数，默认 2
 * @returns 如 "15512888.02"；入参无效时返回 "-"
 *
 * 示例：
 *   fmtNum(15512888.02248082, 2)   → "15512888.02"
 *   fmtNum("0.7625")               → "0.76"
 *   fmtNum(null)                   → "-"
 *   fmtNum(Infinity)               → "-"
 */
export function fmtNum(
  v: number | string | null | undefined,
  digits = 2,
): string {
  const n = toNum(v);
  if (n === null) return '-';
  return n.toFixed(digits);
}
