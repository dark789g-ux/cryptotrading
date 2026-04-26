export function formatNumber(value: string | null, digits: number) {
  if (value == null) return '-'
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(digits) : '-'
}

export function formatPercent(value: string | null) {
  if (value == null) return '-'
  const num = Number(value)
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : '-'
}

export function formatAmount(value: string | null) {
  if (value == null) return '-'
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  if (Math.abs(num) >= 100000) return `${(num / 100000).toFixed(2)} 亿`
  return `${num.toFixed(2)} 万`
}

export function formatTradeDate(value: string | null) {
  if (!value || value.length !== 8) return '-'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

export function trendClass(value: string | null) {
  const num = value == null ? 0 : Number(value)
  if (num > 0) return 'trend-up'
  if (num < 0) return 'trend-down'
  return ''
}

export function buildDefaultDateRange(): [number, number] {
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  return [start.getTime(), end.getTime()]
}

export function formatTushareDate(ms: number) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

export function formatDisplayDate(ms: number) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
