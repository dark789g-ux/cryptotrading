import { API_BASE, post, put, request } from '../../client'
import type { KlineChartBar } from './symbols'
import type { NumericConditionPayload } from './aShares'

// 美股价格口径：qfq=前复权（默认，技术分析口径）/ raw=不复权。
// 与 A 股 ASharePriceMode 同枚举，但独立定义点（避免跨模块耦合）。
export type UsStockPriceMode = 'qfq' | 'raw'

export interface UsStockSummary {
  totalSymbols: string
  latestTradeDate: string | null
  upCount: string
  downCount: string
  quotedCount: string
}

export interface UsStockRow {
  ticker: string
  name: string
  theme: string | null
  stockType: string | null
  close: string | null
  change: string | null
  pctChg: string | null
  volume: string | null
  amount: string | null
  tradeDate: string | null
  // ── 技术指标列（后端 SELECT 别名，canonical key 与共享 descriptor 一致）──
  // 数值列 PG NUMERIC/double 经 JSON 返回为 string。美股无 brick*/amv_* 字段。
  ma5: string | null; ma30: string | null; ma60: string | null; ma120: string | null; ma240: string | null
  bbi: string | null
  kdjJ: string | null; kdjK: string | null; kdjD: string | null
  dif: string | null; dea: string | null; macd: string | null
  quoteVolume10: string | null
  atr14: string | null; lossAtr14: string | null; low9: string | null; high9: string | null
  riskRewardRatio: string | null; stopLossPct: string | null
}

export interface UsStockKlineBar extends KlineChartBar {
  pctChg: number | null
  quote_volume: number
  '10_quote_volume': number | null
  atr_14: number | null
  loss_atr_14: number | null
  low_9: number | null
  high_9: number | null
  stop_loss_pct: number | null
  risk_reward_ratio: number | null
}

export interface UsStockFilterOptions {
  themes: Array<{ value: string }>
  stockTypes: Array<{ value: string }>
}

export interface UsStockDateRange {
  min: string | null
  max: string | null
}

export interface UsStockQueryBody {
  page: number
  pageSize: number
  q?: string
  theme?: string | null
  stockType?: string | null
  priceMode?: UsStockPriceMode
  sort?: { field?: string; order?: 'ascend' | 'descend' | null; asc?: boolean }
  conditions?: NumericConditionPayload[]
}

export interface UsStockQueryResult {
  rows: UsStockRow[]
  total: number
  page: number
  pageSize: number
}

export interface UsSymbol {
  ticker: string
  name: string | null
  theme: string | null
  tracked: boolean
}

export interface UsStockSyncResult {
  jobId: string
}

/** POST /api/us-stocks/one-click-sync body：dateRange 为 [startDate, endDate]（YYYYMMDD）。 */
export interface UsOneClickSyncBody {
  dateRange: [string, string]
}

/**
 * 美股一键同步：POST /api/us-stocks/one-click-sync → 入队 1 条 ml.jobs(run_type='us_one_click_sync')，
 * 返回 jobId；前端用 jobId 轮询 GET /api/quant/jobs/:id 的 resultPayload 渲染三步进度（spec 06-frontend）。
 */
export async function startUsOneClickSync(
  body: UsOneClickSyncBody,
): Promise<{ jobId: string }> {
  return post<{ jobId: string }>(`${API_BASE}/us-stocks/one-click-sync`, body)
}

export const usStocksApi = {
  getSummary: () => request<UsStockSummary>(`${API_BASE}/us-stocks/summary`),
  getFilterOptions: () => request<UsStockFilterOptions>(`${API_BASE}/us-stocks/filter-options`),
  getDateRange: () => request<UsStockDateRange>(`${API_BASE}/us-stocks/date-range`),
  query: (body: UsStockQueryBody) =>
    post<UsStockQueryResult>(`${API_BASE}/us-stocks/query`, body),
  getKlines: (
    ticker: string, limit = 300, priceMode: UsStockPriceMode = 'qfq',
    range?: { startDate?: string; endDate?: string },   // YYYYMMDD
  ) => {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    qs.set('priceMode', priceMode)
    if (range?.startDate) qs.set('startDate', range.startDate)
    if (range?.endDate)   qs.set('endDate', range.endDate)
    return request<UsStockKlineBar[]>(`${API_BASE}/us-stocks/${encodeURIComponent(ticker)}/klines?${qs.toString()}`)
  },
  listSymbols: () => request<UsSymbol[]>(`${API_BASE}/us-stocks/symbols`),
  toggleTracked: (items: Array<{ ticker: string; tracked: boolean }>) =>
    put<{ ok: true }>(`${API_BASE}/us-stocks/symbols/tracked`, { items }),
  // POST /sync → 写一行 ml.jobs(run_type='us_sync')，返回 jobId；前端拿 jobId 复用量化 jobs SSE 跟进度。
  sync: (body: { startDate?: string; endDate?: string; tickers?: string[] } = {}) =>
    post<UsStockSyncResult>(`${API_BASE}/us-stocks/sync`, body),
}
