import { API_BASE, request } from '../../client'

export type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowSyncEvent,
  MoneyFlowSyncSummary,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowMemberRow,
} from '@cryptotrading/shared-types'

import type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowMemberRow,
} from '@cryptotrading/shared-types'

export interface MoneyFlowDateRange {
  min: string | null
  max: string | null
}

function buildQs(params: MoneyFlowQueryParams): string {
  const qs = new URLSearchParams()
  if (params.trade_date) qs.set('trade_date', params.trade_date)
  if (params.start_date) qs.set('start_date', params.start_date)
  if (params.end_date) qs.set('end_date', params.end_date)
  if (params.ts_code) qs.set('ts_code', params.ts_code)
  if (params.limit) qs.set('limit', String(params.limit))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export const moneyFlowApi = {
  getDateRange: () =>
    request<MoneyFlowDateRange>(`${API_BASE}/money-flow/date-range`),

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

  syncRunUrl: (params: MoneyFlowSyncParams) => {
    const qs = new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
    })
    if (params.syncMode) qs.set('syncMode', params.syncMode)
    return `${API_BASE}/money-flow/sync/run?${qs.toString()}`
  },

  getMembers: (tsCode: string, tradeDate?: string | null) => {
    const qs = new URLSearchParams({ ts_code: tsCode })
    if (tradeDate) qs.set('trade_date', tradeDate)
    return request<MoneyFlowMemberRow[]>(`${API_BASE}/money-flow/members?${qs.toString()}`)
  },
}
