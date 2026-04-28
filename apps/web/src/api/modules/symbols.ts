import { API_BASE, patch, post, request } from '../client'

export interface TradeOnBar {
  type: 'entry' | 'exit'
  symbol: string
  price: number
  shares: number
  reason: string
  pnl?: number
  isHalf?: boolean
  kellyRaw?: number
  kellyAdjusted?: number
  positionRatio?: number
  windowWinRate?: number
  windowOdds?: number
}

export interface BrickChartPoint {
  brick: number
  delta: number
  xg: boolean
}

export interface KlineChartBar {
  open_time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  MA5: number | null
  MA30: number | null
  MA60: number | null
  MA120: number | null
  MA240: number | null
  'KDJ.K': number | null
  'KDJ.D': number | null
  'KDJ.J': number | null
  DIF: number | null
  DEA: number | null
  MACD: number | null
  BBI: number | null
  brickChart?: BrickChartPoint
  trades?: TradeOnBar[]
}

export interface SymbolDateRange {
  min: string | null
  max: string | null
}

export type SymbolConditionPayload =
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; valueType?: 'number'; value: number }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; valueType: 'field'; compareField: string }

export interface SymbolQueryBody {
  interval?: string
  q?: string
  page?: number
  pageSize?: number
  page_size?: number
  sort?: { field?: string | null; order?: 'ascend' | 'descend' | null; asc?: boolean }
  conditions?: SymbolConditionPayload[]
}

export interface SymbolRow extends Record<string, unknown> {
  symbol: string
}

export interface SymbolQueryResult {
  items: SymbolRow[]
  total: number
}

export const symbolApi = {
  getNames: (interval = '1h') => request<string[]>(`${API_BASE}/symbols/names?interval=${interval}`),
  getDateRange: (interval = '1h') =>
    request<SymbolDateRange>(`${API_BASE}/symbols/date-range?interval=${interval}`),
  getKlineColumns: () => request<string[]>(`${API_BASE}/symbols/kline-columns`),
  query: (body: SymbolQueryBody) => post<SymbolQueryResult>(`${API_BASE}/symbols/query`, body),
  patch: (symbol: string, body: Record<string, unknown>) =>
    patch<SymbolRow>(`${API_BASE}/symbols/${symbol}`, body),
}

export const klinesApi = {
  getKlines: (symbol: string, interval = '1d') =>
    request<KlineChartBar[]>(`${API_BASE}/klines/${symbol}/${interval}`),
}
