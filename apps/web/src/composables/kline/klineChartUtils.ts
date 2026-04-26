import { CANDLE_COLORS } from './chartColors'

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
