import { API_BASE, patch, post, request } from '../../client'

/** KDJ 指标参数（RSV 周期 n、K 平滑 m1、D 平滑 m2） */
export interface KdjSubplotParams {
  n: number
  m1: number
  m2: number
}

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
  /**
   * 资金净流入（单位亿元）。由 `mergeKlineWithMoneyFlow` 在 fetcher 层按
   * 日期合并到行内，KlineChart 副图按 index 直读 `data[i].moneyFlow`。
   * - `null` 表示该 bar 当日无资金流数据（如新股、停牌）
   * - 不存在该字段表示业务方未启用资金流副图
   */
  moneyFlow?: number | null
  /**
   * 活跃市值（AMV）副图数据。由 mergeKlineWithAmv 在 fetcher 层按 trade_date 合并到行内，
   * KlineChart 的 '0AMV' / '0AMV_MACD' 副图按 index 直读。
   * - `'0AMV'`：活跃市值收盘（amvClose），单线
   * - `'0AMV.DIF' / '0AMV.DEA' / '0AMV.MACD'`：AMV 序列的 MACD（柱 + 双线）
   * - `null` 表示该 bar 当日无 AMV 数据（停牌 / 热身段裁掉 / 缺日）
   * - 不存在这些字段表示业务方未启用 AMV 副图（crypto / backtest）
   */
  '0AMV'?: number | null
  '0AMV.DIF'?: number | null
  '0AMV.DEA'?: number | null
  '0AMV.MACD'?: number | null
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
  name?: string | null
  tags?: { id: string; name: string }[]
}

/** 自选表 quotes 行（camelCase 字段与 watchlistColumnDefs 对齐） */
export interface WatchlistQuoteRow extends SymbolRow {
  market?: string | null
  swIndustryL1Code?: string | null
  swIndustryL2Code?: string | null
  swIndustryL3Code?: string | null
  swIndustryL1Name?: string | null
  swIndustryL2Name?: string | null
  swIndustryL3Name?: string | null
  pctChg?: string | number | null
  amount?: string | number | null
  turnoverRate?: string | number | null
  pe?: string | number | null
  peTtm?: string | number | null
  pb?: string | number | null
  circMv?: string | number | null
  tradeDate?: string | null
  close?: string | number | null
  ma5?: number | null
  ma30?: number | null
  ma60?: number | null
  ma120?: number | null
  ma240?: number | null
  kdjJ?: number | null
  kdjK?: number | null
  kdjD?: number | null
  dif?: number | null
  dea?: number | null
  macd?: number | null
  bbi?: number | null
  quoteVolume10?: number | null
  atr14?: number | null
  lossAtr14?: number | null
  low9?: number | null
  high9?: number | null
  riskRewardRatio?: number | null
  stopLossPct?: number | null
  openTime?: string | number | Date | null
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
  recalcKlines: (
    symbol: string,
    interval = '1d',
    body: { kdjParams?: KdjSubplotParams } = {},
  ) => post<KlineChartBar[]>(`${API_BASE}/klines/${symbol}/${interval}/recalc`, body),
}
