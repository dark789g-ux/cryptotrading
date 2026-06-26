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

/**
 * 格式化市值（万元 → 亿/万亿）。
 * Tushare daily_basic 的 total_mv / circ_mv 单位为万元，与 amount（千元）不同，
 * 不能复用 formatAmount（会差 10 倍）。
 */
export function formatMarketCap(value: string | null) {
  if (value == null) return '-'
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  if (Math.abs(num) >= 1_0000_0000) return `${(num / 1_0000_0000).toFixed(2)} 万亿`
  if (Math.abs(num) >= 1_0000) return `${(num / 1_0000).toFixed(2)} 亿`
  return `${num.toFixed(2)} 万`
}

/** 资金净流入（万元口径 → 亿/万）。net_amount 单位为万元，禁用千元口径的 formatAmount。 */
export function formatMoneyFlow(value: string | null): string {
  if (value == null) return '—'
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  if (Math.abs(num) >= 1_0000) return `${(num / 1_0000).toFixed(2)} 亿`
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

// 日期选择器是"用户在日历上指了哪一天"的本地语义——naive-ui n-date-picker
// 返回的就是本地午夜 ms。这里必须用本地方法取年月日，否则 CST 用户选的日期会被
// UTC 化函数整体推前 1 天（曾经因此导致 20260509-20260511 被压成 20260508-20260510）。
// CLAUDE.md "时间规范"约束的是 DB 入库瞬时，跟此处的日历日语义不冲突。
export function buildDefaultDateRange(): [number, number] {
  const now = new Date()
  const endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startMs = endMs - 6 * 24 * 3600 * 1000
  return [startMs, endMs]
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

/**
 * 量比（保留2位 + "倍"后缀；null 或非有限数时返回 '-'，避免拼出 '-倍'）。
 */
export function formatVolumeRatio(value: string | null): string {
  if (value == null) return '-'
  const formatted = formatNumber(value, 2)
  return formatted === '-' ? '-' : `${formatted}倍`
}
