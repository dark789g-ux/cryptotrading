import { CANDLE_COLORS } from './chartColors'
import type { KlineChartBar } from '@/api'

export const ARROW_RICH = {
  arrowUp: { fill: CANDLE_COLORS.up, fontSize: 12 },
  arrowDown: { fill: CANDLE_COLORS.down, fontSize: 12 },
  arrowEq: { fill: CANDLE_COLORS.eq, fontSize: 12 },
} as const

export const fmt = (value: unknown, digits = 4) =>
  value === null || value === undefined || Number.isNaN(Number(value)) ? '-' : Number(value).toFixed(digits)

export const fmtCompact = (value: unknown, digits = 2) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  const abs = Math.abs(num)
  if (abs >= 100_000_000) return `${(num / 100_000_000).toFixed(digits)}亿`
  if (abs >= 10_000) return `${(num / 10_000).toFixed(digits)}万`
  return num.toFixed(digits)
}

export const fmtXg = (value: boolean | undefined) => (value ? '1' : '0')

export const arrowRichTag = (key: 'up' | 'down' | 'eq'): string => {
  if (key === 'up') return 'arrowUp'
  if (key === 'down') return 'arrowDown'
  return 'arrowEq'
}

export const arrow = (current: unknown, previous: unknown): { sym: string; key: 'up' | 'down' | 'eq' } => {
  const cur = Number(current)
  const prev = Number(previous)
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return { sym: '-', key: 'eq' }
  if (cur > prev) return { sym: '↑', key: 'up' }
  if (cur < prev) return { sym: '↓', key: 'down' }
  return { sym: '-', key: 'eq' }
}

// ── 成交量"相对前收"明暗着色 ──────────────────────────────────────────
// 基色由本根 K 线实体方向决定（沿用 close >= open → 涨），明暗由
// "实体方向 vs close vs 上一根 bar 收盘价 方向"是否一致决定：
//   一致（含首根/平盘）→ 实色 (alpha=1)；背离 → 浅色 (alpha=VOL_BIAS_ALPHA)
const VOL_BIAS_ALPHA = 0.35
const VOL_FLAT_TOLERANCE = 1e-9

/**
 * 解析成交量柱颜色。
 * @param prevClose 上一根 bar 的收盘价；首根传 null（视为实色）
 */
export function resolveVolumeColor(row: KlineChartBar, prevClose: number | null): string {
  const up = row.close >= row.open
  const baseHex = up ? CANDLE_COLORS.up : CANDLE_COLORS.down
  return hexToRgba(baseHex, isVolumeConfirmed(row, prevClose) ? 1 : VOL_BIAS_ALPHA)
}

function isVolumeConfirmed(row: KlineChartBar, prevClose: number | null): boolean {
  if (prevClose == null) return true // 首根无前驱 → 实色
  const diff = row.close - prevClose
  if (Math.abs(diff) <= Math.abs(prevClose) * VOL_FLAT_TOLERANCE) return true // 平盘（含浮点容差）→ 实色
  const up = row.close >= row.open
  return up ? diff > 0 : diff < 0 // 实体方向 与 前收方向 同向 → 实色
}

/**
 * '#0ECB81' → 'rgba(14,203,129,alpha)'
 * 约定：基色必须为 6 位 hex（CANDLE_COLORS.up/down 当前即此格式）。
 * 非预期格式原样返回（不带 alpha）——这会让背离柱静默退化为实色，
 * 因此若未来调整基色格式，须同步更新此正则或基色配置。
 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r},${g},${b},${alpha})`
}
