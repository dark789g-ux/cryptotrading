import { API_BASE, del, post, put, request } from '../../client'
import { appendQueryParam } from '../../query'
import type { KdjSubplotParams, KlineChartBar } from './symbols'

export type ASharePriceMode = 'qfq' | 'raw'
export type NumericConditionPayload =
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; valueType?: 'number'; value: number }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; valueType: 'field'; compareField: string }

export interface AShareSummary {
  totalSymbols: string
  latestTradeDate: string | null
  upCount: string
  downCount: string
  quotedCount: string
}

export interface AShareRow {
  tsCode: string
  symbol: string
  name: string
  market: string | null
  industry: string | null
  close: string | null
  change: string | null
  pctChg: string | null
  amount: string | null
  turnoverRate: string | null
  volumeRatio: string | null
  pe: string | null
  peTtm: string | null
  pb: string | null
  totalMv?: string | null
  circMv?: string | null
  tradeDate: string | null
  // ── 技术指标列（T1 后端 SELECT 别名，canonical key 与共享 descriptor 一致）──
  // 数值列 PG NUMERIC/double 经 JSON 返回为 string；brickXg 例外为 boolean（DB brick_xg 是 boolean，
  // node-postgres 直接解析为 JS boolean，不是数字串）。
  ma5: string | null; ma30: string | null; ma60: string | null; ma120: string | null; ma240: string | null
  bbi: string | null
  kdjJ: string | null; kdjK: string | null; kdjD: string | null
  dif: string | null; dea: string | null; macd: string | null
  atr14: string | null; lossAtr14: string | null; low9: string | null; high9: string | null
  riskRewardRatio: string | null; stopLossPct: string | null
  quoteVolume10: string | null
  brick: string | null; brickDelta: string | null; brickXg: boolean | null
  amvDif: string | null; amvDea: string | null; amvMacd: string | null
  roc10: string | null; roc20: string | null; roc60: string | null
  tags?: { id: string; name: string }[]
}

export interface AShareKlineBar extends KlineChartBar {
  pctChg: number | null
  quote_volume: number
  '10_quote_volume': number | null
  atr_14: number | null
  loss_atr_14: number | null
  low_9: number | null
  high_9: number | null
  stop_loss_pct: number | null
  risk_reward_ratio: number | null
  turnoverRate: number | null
  volumeRatio: number | null
  pe: number | null
  peTtm: number | null
  pb: number | null
  totalMv: number | null
  circMv: number | null
}

export interface AShareFilterOptions {
  markets: Array<{ value: string }>
  industries: Array<{ value: string }>
}

export interface AShareDateRange {
  min: string | null
  max: string | null
}

export interface AShareQueryBody {
  page: number
  pageSize: number
  q?: string
  market?: string | null
  industry?: string | null
  priceMode?: ASharePriceMode
  sort?: { field?: string; order?: 'ascend' | 'descend' | null; asc?: boolean }
  conditions?: NumericConditionPayload[]
  watchlistIds?: string[]
  strategyHitIds?: string[]
  indexTsCode?: string
}

export interface AShareFilterPresetFilters {
  searchQuery: string
  selectedMarket: string | null
  selectedIndustry: string | null
  priceMode: ASharePriceMode
  pctChangeMin: number | null
  turnoverRateMin: number | null
  advancedConditions: NumericConditionPayload[]
}

export interface AShareFilterPreset {
  id: string
  name: string
  filters: AShareFilterPresetFilters
  createdAt: string
  updatedAt: string
}

export interface AShareSyncResult {
  ok: boolean
  status: 'done' | 'partial' | 'error'
  symbols: number
  quotes: number
  metrics: number
  adjFactors: number
  indicators: number
  failedCount: number
  failedItems: Array<{ tradeDate?: string; apiName: string; message: string }>
  startDate: string
  endDate: string
  skippedDates?: number
  skippedDatasets?: number
}

export type AShareSyncMode = 'incremental' | 'overwrite'

export interface AShareQueryResult {
  rows: AShareRow[]
  total: number
  page: number
  pageSize: number
}

export interface AShareSyncBody {
  tradeDate?: string
  startDate?: string
  endDate?: string
  syncMode?: AShareSyncMode
}

export const aSharesApi = {
  getSummary: () => request<AShareSummary>(`${API_BASE}/a-shares/summary`),
  getFilterOptions: () => request<AShareFilterOptions>(`${API_BASE}/a-shares/filter-options`),
  getDateRange: () => request<AShareDateRange>(`${API_BASE}/a-shares/date-range`),
  listFilterPresets: () => request<AShareFilterPreset[]>(`${API_BASE}/a-shares/filter-presets`),
  createFilterPreset: (body: { name: string; filters: AShareFilterPresetFilters }) =>
    post<AShareFilterPreset>(`${API_BASE}/a-shares/filter-presets`, body),
  updateFilterPreset: (id: string, body: { name?: string; filters?: AShareFilterPresetFilters }) =>
    put<AShareFilterPreset>(`${API_BASE}/a-shares/filter-presets/${id}`, body),
  deleteFilterPreset: (id: string) => del<{ ok: true }>(`${API_BASE}/a-shares/filter-presets/${id}`),
  query: (body: AShareQueryBody) =>
    post<AShareQueryResult>(`${API_BASE}/a-shares/query`, body),
  getKlines: (
    tsCode: string, limit = 300, priceMode: ASharePriceMode = 'qfq',
    range?: { startDate?: string; endDate?: string },   // 新增，YYYYMMDD
  ) => {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    qs.set('priceMode', priceMode)
    if (range?.startDate) qs.set('startDate', range.startDate)
    if (range?.endDate)   qs.set('endDate', range.endDate)
    return request<AShareKlineBar[]>(`${API_BASE}/a-shares/${encodeURIComponent(tsCode)}/klines?${qs.toString()}`)
  },
  recalcKlines: (
    tsCode: string, limit = 300, priceMode: ASharePriceMode = 'qfq',
    range?: { startDate?: string; endDate?: string },
    body: { kdjParams?: KdjSubplotParams } = {},
  ) => {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    qs.set('priceMode', priceMode)
    if (range?.startDate) qs.set('startDate', range.startDate)
    if (range?.endDate)   qs.set('endDate', range.endDate)
    return post<AShareKlineBar[]>(`${API_BASE}/a-shares/${encodeURIComponent(tsCode)}/klines/recalc?${qs.toString()}`, body)
  },
  sync: (body: AShareSyncBody = {}) =>
    post<AShareSyncResult>(`${API_BASE}/a-shares/sync`, body),
  syncRunUrl: (body: AShareSyncBody = {}) => {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'tradeDate', body.tradeDate)
    appendQueryParam(qs, 'startDate', body.startDate)
    appendQueryParam(qs, 'endDate', body.endDate)
    appendQueryParam(qs, 'syncMode', body.syncMode)
    const query = qs.toString()
    return `${API_BASE}/a-shares/sync/run${query ? `?${query}` : ''}`
  },
}
