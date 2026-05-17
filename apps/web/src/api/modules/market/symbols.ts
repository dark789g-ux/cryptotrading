import { API_BASE, patch, post, request } from '../../client'

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

export interface MoneyFlowBar {
  /**
   * 副图对齐 K 线主图的关键 key：必须与同一 chart 的 KlineChartBar.open_time
   * 格式完全一致，否则 KlineChart 副图 flowMap.get(open_time) 全 miss，
   * 副图柱形画不出。各业务接入的实际格式：
   * - 行业/板块（ths-index-daily.service.ts:93）：'YYYYMMDD'
   * - A 股（a-shares.service.ts:221 用 formatTradeDateLabel）：'YYYY-MM-DD'
   * 由各自的 fetcher 负责把数据库原值（'YYYYMMDD'）归一为对应格式。
   */
  trade_date: string
  net_amount: number   // 单位亿元（后端 toYi() 已转）
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
  watchlistIds?: string[]
  strategyHitIds?: string[]
}

export interface SymbolRow extends Record<string, unknown> {
  symbol: string
  tags?: { id: string; name: string }[]
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
