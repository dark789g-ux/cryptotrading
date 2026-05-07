import { API_BASE, post, request } from '../client'

export type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
} from '@cryptotrading/shared-types'

import type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
} from '@cryptotrading/shared-types'

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
