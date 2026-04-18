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
  getStrategies: (sortField?: string, sortOrder?: 'ASC' | 'DESC') => {
    const params = new URLSearchParams()
    if (sortField) params.set('sortField', sortField)
    if (sortOrder) params.set('sortOrder', sortOrder)
    const qs = params.toString()
    return request<any[]>(`${API_BASE}/strategies${qs ? `?${qs}` : ''}`)
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
}

export interface CandleLogExit {
  symbol: string
  price: number
  shares: number
  amount: number
  pnl: number
  reason: string
  isHalf: boolean
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
}

export interface CandleLogPage {
  rows: CandleLogRow[]
  total: number
  page: number
  pageSize: number
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

export interface BacktestCandleLogFilters {
  onlyWithAction?: boolean
  symbol?: string
  inCooldown?: boolean | null
  startTs?: string | null
  endTs?: string | null
  sortBy?: 'bar_idx' | 'ts' | 'open_equity' | 'close_equity' | 'pos_count'
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
    if (params.onlyWithAction) qs.set('onlyWithAction', 'true')
    appendQueryParam(qs, 'symbol', params.symbol)
    if (typeof params.inCooldown === 'boolean') qs.set('inCooldown', String(params.inCooldown))
    appendQueryParam(qs, 'startTs', params.startTs)
    appendQueryParam(qs, 'endTs', params.endTs)
    appendQueryParam(qs, 'sortBy', params.sortBy)
    appendQueryParam(qs, 'sortOrder', params.sortOrder)
    return request<CandleLogPage>(`${API_BASE}/backtest/runs/${runId}/candle-log?${qs.toString()}`)
  },
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

// ── K 线 ────────────────────────────────────────────────────
export const klinesApi = {
  getKlines: (symbol: string, interval = '1d') =>
    request<any[]>(`${API_BASE}/klines/${symbol}/${interval}`),
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
