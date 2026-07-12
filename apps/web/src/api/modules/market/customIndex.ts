import { API_BASE, del, patch, post, request } from '../../client'
import type { KlineChartBar } from './symbols'
import type { AmvSeriesRow } from './active-mv'

/** GET /api/custom-indices/latest 单行（camelCase wire） */
export type CustomIndexStatus = 'pending' | 'computing' | 'ready' | 'failed'
export type CustomIndexType = 'price' | 'total_return'
export type CustomWeightMethod = 'equal' | 'float_mv' | 'custom'

export interface CustomIndexLatestRow {
  id: string
  tsCode: string
  name: string
  category: 'custom'
  tradeDate: string | null
  close: number | null
  pctChange: number | null
  vol: number | null
  amount: number | null
  count: number | null
  status: CustomIndexStatus
  computeProgress: number | null
  indexType: CustomIndexType
  weightMethod: CustomWeightMethod
  baseDate: string
  basePoint: number
  actualStartDate: string | null
  lastError?: string | null
  netAmount: number | null
  netAmount5d: number | null
  netAmount10d: number | null
  netAmount20d: number | null
  buyLgAmount: number | null
  buyMdAmount: number | null
  buySmAmount: number | null
}

export interface CustomIndexLatestResult {
  rows: CustomIndexLatestRow[]
  total: number
}

export type CustomIndexLatestSortField =
  | 'pct_change'
  | 'close'
  | 'count'
  | 'tradeDate'
  | 'net_amount'
  | 'net_amount_5d'
  | 'net_amount_10d'
  | 'net_amount_20d'

export interface CustomIndexLatestQuery {
  q?: string
  sort?: CustomIndexLatestSortField
  order?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface CustomIndexMemberRow {
  conCode: string
  name: string
  weight: number
}

export interface CustomIndexDetail {
  id: string
  tsCode: string
  name: string
  description: string | null
  indexType: CustomIndexType
  baseDate: string
  basePoint: number
  weightMethod: CustomWeightMethod
  effectiveDate: string
  status: CustomIndexStatus
  members: CustomIndexMemberRow[]
}

export interface CreateCustomIndexBody {
  name: string
  description?: string
  index_type: CustomIndexType
  base_date: string
  base_point: number
  weight_method: CustomWeightMethod
  effective_date: string
  members: Array<{ con_code: string; weight?: number }>
  custom_weights?: Array<{ con_code: string; weight: number }> | null
}

export interface UpdateCustomIndexBody {
  name?: string
  description?: string
  index_type?: CustomIndexType
  weight_method?: CustomWeightMethod
  effective_date?: string
  members?: Array<{ con_code: string; weight?: number }>
  custom_weights?: Array<{ con_code: string; weight: number }> | null
}

export interface PreviewWeightsBody {
  weight_method: CustomWeightMethod
  members: Array<{ con_code: string; weight?: number }>
  effective_date: string
}

export interface CreateCustomIndexResult {
  id: string
  ts_code: string
  status: CustomIndexStatus
}

export interface CustomIndexSseProgressEvent {
  progress: number
  stage?: string | null
  status: CustomIndexStatus
  last_error?: string | null
}

/** GET /api/custom-indices/:id/money-flow 单行（金额单位：亿元） */
export interface CustomIndexMoneyFlowRow {
  tradeDate: string
  netAmount: number | null
  buyLgAmount: number | null
  buyMdAmount: number | null
  buySmAmount: number | null
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value))
  }
  const query = qs.toString()
  return query ? `?${query}` : ''
}

export const customIndexApi = {
  getLatestList: (params: CustomIndexLatestQuery = {}) =>
    request<CustomIndexLatestResult>(
      `${API_BASE}/custom-indices/latest${buildQuery({
        q: params.q,
        sort: params.sort,
        order: params.order,
        page: params.page,
        pageSize: params.pageSize,
      })}`,
    ),

  getById: (id: string) =>
    request<CustomIndexDetail>(`${API_BASE}/custom-indices/${encodeURIComponent(id)}`),

  getMembers: (id: string, asOfDate?: string) =>
    request<{ members: CustomIndexMemberRow[] }>(
      `${API_BASE}/custom-indices/${encodeURIComponent(id)}/members${buildQuery({
        as_of_date: asOfDate,
      })}`,
    ),

  previewWeights: (body: PreviewWeightsBody) =>
    post<{ members: CustomIndexMemberRow[] }>(`${API_BASE}/custom-indices/preview-weights`, body),

  getIndexCatalogMembers: (tsCode: string) =>
    request<{ members: Array<{ conCode: string; name: string }> }>(
      `${API_BASE}/index-catalog/${encodeURIComponent(tsCode)}/members`,
    ),

  create: (body: CreateCustomIndexBody) =>
    post<CreateCustomIndexResult>(`${API_BASE}/custom-indices`, body),

  update: (id: string, body: UpdateCustomIndexBody) =>
    patch<CreateCustomIndexResult>(`${API_BASE}/custom-indices/${encodeURIComponent(id)}`, body),

  delete: (id: string) =>
    del<{ ok: true }>(`${API_BASE}/custom-indices/${encodeURIComponent(id)}`),

  recompute: (id: string) =>
    post<CreateCustomIndexResult>(`${API_BASE}/custom-indices/${encodeURIComponent(id)}/recompute`),

  getKline: (id: string, startDate: string, endDate: string) =>
    request<KlineChartBar[]>(
      `${API_BASE}/custom-indices/${encodeURIComponent(id)}/kline${buildQuery({
        start_date: startDate,
        end_date: endDate,
      })}`,
    ),

  getAmv: (id: string, startDate: string, endDate: string) =>
    request<AmvSeriesRow[]>(
      `${API_BASE}/custom-indices/${encodeURIComponent(id)}/amv${buildQuery({
        startDate,
        endDate,
      })}`,
    ),

  getMoneyFlow: (id: string, startDate: string, endDate: string) =>
    request<CustomIndexMoneyFlowRow[]>(
      `${API_BASE}/custom-indices/${encodeURIComponent(id)}/money-flow${buildQuery({
        start_date: startDate,
        end_date: endDate,
      })}`,
    ),

  issueSseToken: (id: string) =>
    post<{ token: string; expires_at: string }>(
      `${API_BASE}/custom-indices/${encodeURIComponent(id)}/sse-token`,
    ),

  buildSseUrl: (id: string, token: string) => {
    const qs = new URLSearchParams({ token })
    return `${API_BASE}/custom-indices/${encodeURIComponent(id)}/stream?${qs.toString()}`
  },
}
