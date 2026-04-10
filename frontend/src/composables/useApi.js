/**
 * API 请求封装
 */

const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(BASE + path, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json()
  return res.text()
}

export const api = {
  // 标的
  getIntervals: () => request('/intervals'),
  getFilterStrategies: () => request('/filter-strategies'),
  getSymbols: (interval, strategy = '') =>
    request(`/symbols?interval=${interval}&strategy=${encodeURIComponent(strategy)}`),
  getKlines: (interval, symbol) =>
    request(`/klines/${interval}/${encodeURIComponent(symbol)}`),

  // 回测策略
  getStrategyTypes: () => request('/strategy-types'),
  listStrategies: () => request('/strategies'),
  createStrategy: (body) => request('/strategies', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  updateStrategy: (id, body) => request(`/strategies/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  deleteStrategy: (id) => request(`/strategies/${id}`, { method: 'DELETE' }),
  getBacktestResult: (id) => request(`/backtest/${id}/result`),

  // 同步偏好
  getSyncPreferences: () => request('/sync/preferences'),
  saveSyncPreferences: (body) => request('/sync/preferences', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
}
