import { API_BASE, post, request } from '../client'
import { appendQueryParam } from '../query'
import type { KlineChartBar } from './symbols'

export interface CandleLogEntry {
  symbol: string
  price: number
  shares: number
  amount: number
  reason: string
  isSimulation: boolean
  tradePhase?: 'simulation' | 'probe' | 'live'
  kellyRaw?: number
  kellyAdjusted?: number
  positionRatio?: number
  windowWinRate?: number
  windowOdds?: number
}

export interface CandleLogExit {
  symbol: string
  price: number
  shares: number
  amount: number
  pnl: number
  reason: string
  isHalf: boolean
  isSimulation: boolean
  tradePhase?: 'simulation' | 'probe' | 'live'
  overallReturnPct?: number
  cumulativeWinRate?: number
  cumulativeOdds?: number
  windowWinRate?: number
  windowOdds?: number
}

export interface CandleLogRow {
  barIdx: number
  ts: string
  openEquity: number
  closeEquity: number
  posCount: number
  maxPositions: number
  entries: CandleLogEntry[]
  exits: CandleLogExit[]
  inCooldown: boolean
  cooldownDuration: number | null
  cooldownRemaining: number | null
}

export interface CandleLogPage {
  rows: CandleLogRow[]
  total: number
  page: number
  pageSize: number
}

export interface RunSymbolMetricRow {
  symbol: string
  dataStatus: 'ok' | 'missing'
  /** entries 或本根相对上一根新增收盘持仓 */
  buyOnBar: boolean
  /** exits 或本根相对上一根减少收盘持仓 */
  sellOnBar: boolean
  /** 本根 K 线收盘时仍持仓 */
  holdAtClose: boolean
  close: number | null
  ma5: number | null
  ma30: number | null
  ma60: number | null
  kdjJ: number | null
  riskRewardRatio: number | null
  stopLossPct: number | null
}

export interface RunSymbolMetricsPage {
  items: RunSymbolMetricRow[]
  total: number
  page: number
  page_size: number
}

export interface BacktestPositionFilters {
  symbol?: string
  pnlMin?: number | null
  pnlMax?: number | null
  returnPctMin?: number | null
  returnPctMax?: number | null
  stopType?: string
  entryStart?: string | null
  entryEnd?: string | null
  closeStart?: string | null
  closeEnd?: string | null
}

export interface BacktestSymbolFilters {
  symbol?: string
  totalPnlMin?: number | null
  totalPnlMax?: number | null
  winRateMin?: number | null
  winRateMax?: number | null
}

export type BacktestCandleLogTradeState = 'position' | 'entry' | 'exit'

export interface BacktestCandleLogFilters {
  tradeStates?: readonly BacktestCandleLogTradeState[]
  symbol?: string
  inCooldown?: boolean | null
  tradePhases?: Array<'simulation' | 'probe' | 'live'>
  startTs?: string | null
  endTs?: string | null
  equityChangeMin?: number | null
  equityChangeMax?: number | null
  equityChangePctMin?: number | null
  equityChangePctMax?: number | null
  cooldownDurationMin?: number | null
  cooldownDurationMax?: number | null
  cooldownRemainingMin?: number | null
  cooldownRemainingMax?: number | null
  sortBy?: 'bar_idx' | 'ts' | 'open_equity' | 'close_equity' | 'pos_count' | 'equity_change' | 'equity_change_pct' | 'cooldown_duration' | 'cooldown_remaining'
  sortOrder?: 'asc' | 'desc'
}

export interface BacktestProgress {
  status: 'running' | 'done' | 'error'
  phase: string
  percent: number
  currentTs: string | null
  startTs: string | null
  endTs: string | null
  elapsedMs: number
  etaMs: number | null
  message?: string
  runId?: string
}

export interface BacktestRunRecord extends Record<string, unknown> {
  id: string
  strategyId?: string
  createdAt?: string
}

export interface BacktestRowsPage<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export type BacktestPositionRow = Record<string, unknown>
export type BacktestSymbolRow = Record<string, unknown>

export const backtestApi = {
  listRuns: (strategyId: string) => request<BacktestRunRecord[]>(`${API_BASE}/backtest/runs/${strategyId}`),
  getRun: (runId: string) => request<BacktestRunRecord>(`${API_BASE}/backtest/run/${runId}`),
  start: (strategyId: string, symbols: string[]) =>
    post<{ ok: boolean; message?: string }>(`${API_BASE}/backtest/start/${strategyId}`, { symbols }),
  getProgress: (strategyId: string) =>
    request<BacktestProgress | null>(`${API_BASE}/backtest/progress/${strategyId}`),
  getRunPositions: (
    runId: string,
    params: {
      page?: number
      pageSize?: number
      sortBy?: string
      sortOrder?: 'ASC' | 'DESC'
    } & BacktestPositionFilters,
  ) => {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'page', params.page)
    appendQueryParam(qs, 'pageSize', params.pageSize)
    appendQueryParam(qs, 'sortBy', params.sortBy)
    appendQueryParam(qs, 'sortOrder', params.sortOrder)
    appendQueryParam(qs, 'symbol', params.symbol)
    appendQueryParam(qs, 'pnlMin', params.pnlMin)
    appendQueryParam(qs, 'pnlMax', params.pnlMax)
    appendQueryParam(qs, 'returnPctMin', params.returnPctMin)
    appendQueryParam(qs, 'returnPctMax', params.returnPctMax)
    appendQueryParam(qs, 'stopType', params.stopType)
    appendQueryParam(qs, 'entryStart', params.entryStart)
    appendQueryParam(qs, 'entryEnd', params.entryEnd)
    appendQueryParam(qs, 'closeStart', params.closeStart)
    appendQueryParam(qs, 'closeEnd', params.closeEnd)
    return request<BacktestRowsPage<BacktestPositionRow>>(`${API_BASE}/backtest/runs/${runId}/positions?${qs.toString()}`)
  },
  getRunSymbols: (
    runId: string,
    params: {
      page?: number
      pageSize?: number
      sortBy?: string
      sortOrder?: 'ASC' | 'DESC'
    } & BacktestSymbolFilters,
  ) => {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'page', params.page)
    appendQueryParam(qs, 'pageSize', params.pageSize)
    appendQueryParam(qs, 'sortBy', params.sortBy)
    appendQueryParam(qs, 'sortOrder', params.sortOrder)
    appendQueryParam(qs, 'symbol', params.symbol)
    appendQueryParam(qs, 'totalPnlMin', params.totalPnlMin)
    appendQueryParam(qs, 'totalPnlMax', params.totalPnlMax)
    appendQueryParam(qs, 'winRateMin', params.winRateMin)
    appendQueryParam(qs, 'winRateMax', params.winRateMax)
    return request<BacktestRowsPage<BacktestSymbolRow>>(`${API_BASE}/backtest/runs/${runId}/symbols?${qs.toString()}`)
  },
  getCandleLog: (
    runId: string,
    params: {
      page?: number
      pageSize?: number
    } & BacktestCandleLogFilters,
  ) => {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'page', params.page)
    appendQueryParam(qs, 'pageSize', params.pageSize)
    if (params.tradeStates && params.tradeStates.length > 0) {
      qs.set('tradeStates', params.tradeStates.join(','))
    }
    appendQueryParam(qs, 'symbol', params.symbol)
    if (typeof params.inCooldown === 'boolean') qs.set('inCooldown', String(params.inCooldown))
    appendQueryParam(qs, 'startTs', params.startTs)
    appendQueryParam(qs, 'endTs', params.endTs)
    appendQueryParam(qs, 'equityChangeMin', params.equityChangeMin)
    appendQueryParam(qs, 'equityChangeMax', params.equityChangeMax)
    appendQueryParam(qs, 'equityChangePctMin', params.equityChangePctMin)
    appendQueryParam(qs, 'equityChangePctMax', params.equityChangePctMax)
    appendQueryParam(qs, 'cooldownDurationMin', params.cooldownDurationMin)
    appendQueryParam(qs, 'cooldownDurationMax', params.cooldownDurationMax)
    appendQueryParam(qs, 'cooldownRemainingMin', params.cooldownRemainingMin)
    appendQueryParam(qs, 'cooldownRemainingMax', params.cooldownRemainingMax)
    if (params.tradePhases && params.tradePhases.length > 0) qs.set('tradePhases', params.tradePhases.join(','))
    appendQueryParam(qs, 'sortBy', params.sortBy)
    appendQueryParam(qs, 'sortOrder', params.sortOrder)
    return request<CandleLogPage>(`${API_BASE}/backtest/runs/${runId}/candle-log?${qs.toString()}`)
  },
  getKlineChart: (
    runId: string,
    params: { symbol: string; ts: string; before?: number; after?: number },
  ) => {
    const qs = new URLSearchParams()
    qs.set('symbol', params.symbol)
    qs.set('ts', params.ts)
    if (params.before != null) qs.set('before', String(params.before))
    if (params.after != null) qs.set('after', String(params.after))
    return request<KlineChartBar[]>(`${API_BASE}/backtest/runs/${runId}/kline-chart?${qs.toString()}`)
  },
  querySymbolMetrics: (
    runId: string,
    body: {
      ts: string
      q?: string
      conditions?: { field: string; op: string; value: number }[]
      sort: { field: string; asc: boolean }
      page: number
      page_size: number
      only_buy_on_bar?: boolean
      only_sell_on_bar?: boolean
      only_open_at_close?: boolean
    },
  ) => post<RunSymbolMetricsPage>(`${API_BASE}/backtest/runs/${runId}/symbol-metrics/query`, body),
}
