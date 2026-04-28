import { API_BASE, del, post, put, request } from './client'
import { appendQueryParam } from './query'
import type { KlineChartBar } from './symbols'

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
  getKlines: (tsCode: string, limit = 300, priceMode: ASharePriceMode = 'qfq') => {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    qs.set('priceMode', priceMode)
    return request<AShareKlineBar[]>(`${API_BASE}/a-shares/${encodeURIComponent(tsCode)}/klines?${qs.toString()}`)
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
