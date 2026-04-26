// API 封装 - 匹配 NestJS 后端路由
const API_BASE = '/api'

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  const text = await res.text()
  if (!text.trim()) return null as unknown as T
  return JSON.parse(text) as T
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function put<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function del<T>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' })
}

// ── 策略 ────────────────────────────────────────────────────
export const strategyApi = {
  getStrategyTypes: () => request<any[]>(`${API_BASE}/strategies/types`),
  getStrategies: (sortField?: string, sortOrder?: 'ASC' | 'DESC', page?: number, pageSize?: number) => {
    const params = new URLSearchParams()
    if (sortField) params.set('sortField', sortField)
    if (sortOrder) params.set('sortOrder', sortOrder)
    if (page != null) params.set('page', String(page))
    if (pageSize != null) params.set('pageSize', String(pageSize))
    const qs = params.toString()
    return request<{ rows: any[]; total: number; page: number; pageSize: number }>(`${API_BASE}/strategies${qs ? `?${qs}` : ''}`)
  },
  getStrategy: (id: string) => request<any>(`${API_BASE}/strategies/${id}`),
  createStrategy: (data: object) => post<any>(`${API_BASE}/strategies`, data),
  updateStrategy: (id: string, data: object) => put<any>(`${API_BASE}/strategies/${id}`, data),
  deleteStrategy: (id: string) => del<any>(`${API_BASE}/strategies/${id}`),
}

// ── 回测 K线日志类型 ─────────────────────────────────────────
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

function appendQueryParam(qs: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === '') return
  qs.set(key, String(value))
}

// ── 回测 ────────────────────────────────────────────────────
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

export const backtestApi = {
  listRuns: (strategyId: string) => request<any[]>(`${API_BASE}/backtest/runs/${strategyId}`),
  getRun: (runId: string) => request<any>(`${API_BASE}/backtest/run/${runId}`),
  start: (strategyId: string, symbols: string[]) =>
    post<{ ok: boolean; message?: string }>(`${API_BASE}/backtest/start/${strategyId}`, { symbols }),
  getProgress: (strategyId: string) =>
    request<BacktestProgress | null>(`${API_BASE}/backtest/progress/${strategyId}`),
  /** 获取仓位记录（分页+排序） */
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
    return request<{ rows: any[]; total: number; page: number; pageSize: number }>(`${API_BASE}/backtest/runs/${runId}/positions?${qs.toString()}`)
  },
  /** 获取盈亏统计（分页+排序） */
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
    return request<{ rows: any[]; total: number; page: number; pageSize: number }>(`${API_BASE}/backtest/runs/${runId}/symbols?${qs.toString()}`)
  },
  /** 获取 K 线日志（分页） */
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
  /** 获取指定标的在某时间点附近的 K 线数据（用于 K 线图） */
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
  /**
   * 指定 ts 上回测标的池指标快照（分页、筛选、排序）。
   * only_buy_on_bar / only_sell_on_bar / only_open_at_close 多选时为并集（OR）。
   */
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

// ── 标的 ────────────────────────────────────────────────────
export const symbolApi = {
  getNames: (interval = '1h') => request<string[]>(`${API_BASE}/symbols/names?interval=${interval}`),
  getDateRange: (interval = '1h') =>
    request<{ min: string | null; max: string | null }>(`${API_BASE}/symbols/date-range?interval=${interval}`),
  getKlineColumns: () => request<string[]>(`${API_BASE}/symbols/kline-columns`),
  query: (body: object) => post<{ items: any[]; total: number }>(`${API_BASE}/symbols/query`, body),
  patch: (symbol: string, body: object) =>
    request<any>(`${API_BASE}/symbols/${symbol}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}

// A 股
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
  pctChg: string | null
  amount: string | null
  turnoverRate: string | null
  volumeRatio: string | null
  pe: string | null
  pb: string | null
  totalMv?: string | null
  circMv?: string | null
  tradeDate: string | null
}

export interface AShareKlineBar extends KlineChartBar {
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
  pb: number | null
  totalMv: number | null
  circMv: number | null
}

export interface AShareFilterOptions {
  markets: Array<{ value: string }>
  industries: Array<{ value: string }>
}

export interface AShareQueryBody {
  page: number
  pageSize: number
  q?: string
  market?: string | null
  industry?: string | null
  sort?: { field?: string; order?: 'ascend' | 'descend' | null; asc?: boolean }
  conditions?: Array<{ field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: number }>
}

export interface AShareSyncResult {
  ok: boolean
  symbols: number
  quotes: number
  metrics: number
  indicators: number
  startDate: string
  endDate: string
}

export const aSharesApi = {
  getSummary: () => request<AShareSummary>(`${API_BASE}/a-shares/summary`),
  getFilterOptions: () => request<AShareFilterOptions>(`${API_BASE}/a-shares/filter-options`),
  query: (body: AShareQueryBody) =>
    post<{ rows: AShareRow[]; total: number; page: number; pageSize: number }>(`${API_BASE}/a-shares/query`, body),
  getKlines: (tsCode: string, limit = 300) =>
    request<AShareKlineBar[]>(`${API_BASE}/a-shares/${encodeURIComponent(tsCode)}/klines?limit=${limit}`),
  sync: (body: { tradeDate?: string; startDate?: string; endDate?: string } = {}) =>
    post<AShareSyncResult>(`${API_BASE}/a-shares/sync`, body),
  syncRunUrl: (body: { tradeDate?: string; startDate?: string; endDate?: string } = {}) => {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'tradeDate', body.tradeDate)
    appendQueryParam(qs, 'startDate', body.startDate)
    appendQueryParam(qs, 'endDate', body.endDate)
    const query = qs.toString()
    return `${API_BASE}/a-shares/sync/run${query ? `?${query}` : ''}`
  },
}

// ── K 线 ────────────────────────────────────────────────────
export const klinesApi = {
  getKlines: (symbol: string, interval = '1d') =>
    request<KlineChartBar[]>(`${API_BASE}/klines/${symbol}/${interval}`),
}

// ── 同步 ────────────────────────────────────────────────────
export const syncApi = {
  getPreferences: () => request<{ intervals: string[]; symbols: string[] }>(`${API_BASE}/sync/preferences`),
  savePreferences: (body: { intervals: string[]; symbols: string[] }) =>
    put<any>(`${API_BASE}/sync/preferences`, body),
}

// ── 自选列表 ─────────────────────────────────────────────────
export const watchlistApi = {
  list: () => request<any[]>(`${API_BASE}/watchlists`),
  get: (id: string) => request<any>(`${API_BASE}/watchlists/${id}`),
  create: (body: { name: string; symbols?: string[] }) => post<any>(`${API_BASE}/watchlists`, body),
  update: (id: string, body: { name?: string; symbols?: string[] }) => put<any>(`${API_BASE}/watchlists/${id}`, body),
  delete: (id: string) => del<any>(`${API_BASE}/watchlists/${id}`),
}

// ── 标的池预设 ───────────────────────────────────────────────
export interface SymbolPreset {
  id: string
  name: string
  symbols: string[]
  createdAt: string
}

export const symbolPresetApi = {
  list: () => request<SymbolPreset[]>(`${API_BASE}/symbol-presets`),
  create: (body: { name: string; symbols: string[] }) =>
    post<SymbolPreset>(`${API_BASE}/symbol-presets`, body),
  update: (id: string, body: { name?: string; symbols?: string[] }) =>
    put<SymbolPreset>(`${API_BASE}/symbol-presets/${id}`, body),
  delete: (id: string) => del<{ ok: true }>(`${API_BASE}/symbol-presets/${id}`),
}

// ── 设置 ────────────────────────────────────────────────────
export const settingsApi = {
  getExcluded: () => request<string[]>(`${API_BASE}/settings/excluded-symbols`),
  setExcluded: (symbols: string[]) => put<any>(`${API_BASE}/settings/excluded-symbols`, { symbols }),
  getAllConfigs: () => request<Record<string, unknown>>(`${API_BASE}/settings/config`),
  setConfig: (key: string, value: unknown) => put<any>(`${API_BASE}/settings/config/${key}`, { value }),
}
