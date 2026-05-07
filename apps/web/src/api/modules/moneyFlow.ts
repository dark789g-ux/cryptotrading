import { API_BASE, post, request } from '../client'

export interface MoneyFlowQueryParams {
  trade_date?: string
  start_date?: string
  end_date?: string
  ts_code?: string
}

export interface MoneyFlowSyncParams {
  start_date: string
  end_date: string
}

export interface MoneyFlowSyncResult {
  success: number
  skipped: number
  errors: string[]
}

export interface MoneyFlowLatestDates {
  stock: string | null
  industry: string | null
  sector: string | null
  market: string | null
}

export interface MoneyFlowStockRow {
  id: string
  tsCode: string
  tradeDate: string
  name: string | null
  pctChange: string | null
  latest: string | null
  netAmount: string | null
  netD5Amount: string | null
  buyLgAmount: string | null
  buyLgAmountRate: string | null
  buyMdAmount: string | null
  buyMdAmountRate: string | null
  buySmAmount: string | null
  buySmAmountRate: string | null
}

export interface MoneyFlowIndustryRow {
  id: string
  tradeDate: string
  industry: string
  pctChange: string | null
  netAmount: string | null
  buyLgAmount: string | null
  buyMdAmount: string | null
  buySmAmount: string | null
}

export interface MoneyFlowSectorRow {
  id: string
  tradeDate: string
  sector: string
  pctChange: string | null
  netAmount: string | null
  buyLgAmount: string | null
  buyMdAmount: string | null
  buySmAmount: string | null
}

export interface MoneyFlowMarketRow {
  id: string
  tradeDate: string
  netAmount: string | null
  buyLgAmount: string | null
  buySmAmount: string | null
  hkNetAmount: string | null
}

function buildQs(params: MoneyFlowQueryParams): string {
  const qs = new URLSearchParams()
  if (params.trade_date) qs.set('trade_date', params.trade_date)
  if (params.start_date) qs.set('start_date', params.start_date)
  if (params.end_date) qs.set('end_date', params.end_date)
  if (params.ts_code) qs.set('ts_code', params.ts_code)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export const moneyFlowApi = {
  getLatestDates: () =>
    request<MoneyFlowLatestDates>(`${API_BASE}/money-flow/latest-dates`),

  queryStocks: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowStockRow[]>(`${API_BASE}/money-flow/stocks${buildQs(params)}`),

  queryIndustries: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowIndustryRow[]>(`${API_BASE}/money-flow/industries${buildQs(params)}`),

  querySectors: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowSectorRow[]>(`${API_BASE}/money-flow/sectors${buildQs(params)}`),

  queryMarket: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowMarketRow[]>(`${API_BASE}/money-flow/market${buildQs(params)}`),

  syncStocks: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/stocks`, params),

  syncIndustries: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/industries`, params),

  syncSectors: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/sectors`, params),

  syncMarket: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/market`, params),
}
