import { API_BASE, del, post, put, request } from '../client'
import { appendQueryParam } from '../query'

export interface StrategyRecord extends Record<string, unknown> {
  id: string
  name: string
  typeId?: string
  timeframe?: string
  symbols?: string[]
  params?: Record<string, unknown>
  createdAt?: string
  lastBacktestAt?: string | null
  lastBacktestReturn?: number | null
}

export interface StrategyType {
  id: string
  name: string
}

export type StrategyPayload = Record<string, unknown>

export interface StrategyPage {
  rows: StrategyRecord[]
  total: number
  page: number
  pageSize: number
}

export const strategyApi = {
  getStrategyTypes: () => request<StrategyType[]>(`${API_BASE}/strategies/types`),
  getStrategies: (sortField?: string, sortOrder?: 'ASC' | 'DESC', page?: number, pageSize?: number) => {
    const params = new URLSearchParams()
    appendQueryParam(params, 'sortField', sortField)
    appendQueryParam(params, 'sortOrder', sortOrder)
    appendQueryParam(params, 'page', page)
    appendQueryParam(params, 'pageSize', pageSize)
    const qs = params.toString()
    return request<StrategyPage>(`${API_BASE}/strategies${qs ? `?${qs}` : ''}`)
  },
  getStrategy: (id: string) => request<StrategyRecord>(`${API_BASE}/strategies/${id}`),
  createStrategy: (data: StrategyPayload) => post<StrategyRecord>(`${API_BASE}/strategies`, data),
  updateStrategy: (id: string, data: StrategyPayload) => put<StrategyRecord>(`${API_BASE}/strategies/${id}`, data),
  deleteStrategy: (id: string) => del<{ ok: true }>(`${API_BASE}/strategies/${id}`),
}
