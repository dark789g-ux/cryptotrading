import { API_BASE, request } from '../../client'
import type { KlineChartBar } from './symbols'
import type {
  EtfLatestResult,
  EtfPcfRow,
} from '@/components/symbols/a-shares-index/etf.types'

/**
 * ETF 相关 API。
 *
 * 对应后端：
 *  - GET /api/etf/latest   → EtfService.getLatest
 *  - GET /api/etf/kline    → EtfService.getKlines
 *  - GET /api/etf/pcf      → EtfService.getPcf
 */
export interface EtfLatestQuery {
  /** 基金类型筛选 */
  fundType?: string
  /** 管理人筛选 */
  manager?: string
  /** 是否公布 IOPV */
  publishIopv?: string
  /** name 模糊搜索（ILIKE） */
  q?: string
  sort?: string
  /** 'asc' | 'desc' */
  order?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value))
  }
  const query = qs.toString()
  return query ? `?${query}` : ''
}

export const etfApi = {
  /** ETF 列表（远程分页/排序/筛选）。 */
  getLatestList: (params: EtfLatestQuery) =>
    request<EtfLatestResult>(
      `${API_BASE}/etf/latest${buildQuery({
        fundType: params.fundType,
        manager: params.manager,
        publishIopv: params.publishIopv,
        q: params.q,
        sort: params.sort,
        order: params.order,
        page: params.page,
        pageSize: params.pageSize,
      })}`,
    ),

  /** 基金类型枚举（distinct fund_type，供筛选 radio 动态生成）。 */
  getFundTypes: () => request<string[]>(`${API_BASE}/etf/fund-types`),

  /** ETF K 线 + 指标。返回 KlineChartBar[]。 */
  queryKline: (params: {
    ts_code: string
    start_date: string
    end_date: string
  }) =>
    request<KlineChartBar[]>(
      `${API_BASE}/etf/kline?ts_code=${encodeURIComponent(params.ts_code)}` +
        `&start_date=${params.start_date}&end_date=${params.end_date}`,
    ),

  /** PCF 成分股明细。 */
  getPcf: (params: {
    ts_code: string
    trade_date: string
  }) =>
    request<EtfPcfRow[]>(
      `${API_BASE}/etf/pcf?ts_code=${encodeURIComponent(params.ts_code)}` +
        `&trade_date=${params.trade_date}`,
    ),
}
