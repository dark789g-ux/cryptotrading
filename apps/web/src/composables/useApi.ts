// API 封装 - 匹配 NestJS 后端路由
const API_BASE = '/api'

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
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
  getStrategies: () => request<any[]>(`${API_BASE}/strategies`),
  getStrategy: (id: string) => request<any>(`${API_BASE}/strategies/${id}`),
  createStrategy: (data: object) => post<any>(`${API_BASE}/strategies`, data),
  updateStrategy: (id: string, data: object) => put<any>(`${API_BASE}/strategies/${id}`, data),
  deleteStrategy: (id: string) => del<any>(`${API_BASE}/strategies/${id}`),
}

// ── 回测 ────────────────────────────────────────────────────
export const backtestApi = {
  listRuns: (strategyId: string) => request<any[]>(`${API_BASE}/backtest/runs/${strategyId}`),
  getRun: (runId: string) => request<any>(`${API_BASE}/backtest/run/${runId}`),
}

// ── 标的 ────────────────────────────────────────────────────
export const symbolApi = {
  getNames: (interval = '1h') => request<string[]>(`${API_BASE}/symbols/names?interval=${interval}`),
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

// ── 设置 ────────────────────────────────────────────────────
export const settingsApi = {
  getExcluded: () => request<string[]>(`${API_BASE}/settings/excluded-symbols`),
  setExcluded: (symbols: string[]) => put<any>(`${API_BASE}/settings/excluded-symbols`, { symbols }),
  getAllConfigs: () => request<Record<string, unknown>>(`${API_BASE}/settings/config`),
  setConfig: (key: string, value: unknown) => put<any>(`${API_BASE}/settings/config/${key}`, { value }),
}
