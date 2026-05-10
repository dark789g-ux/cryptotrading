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

// 时间规范：UTC 墙钟，禁止使用 getFullYear/getMonth 等本地方法
export function buildDefaultDateRange(): [number, number] {
  const now = new Date()
  const endUTCMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const startUTCMs = endUTCMs - 6 * 24 * 3600 * 1000
  return [startUTCMs, endUTCMs]
}

export function formatTushareDate(ms: number) {
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

export function formatDisplayDate(ms: number) {
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 把后端 timestamptz 字符串/Date 转为 UTC 墙钟 'YYYY-MM-DD HH:MM:SS' */
export function formatUTCDateTime(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return '-'
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`
}
