import { API_BASE, request } from '../../client'
import type { KlineChartBar } from './symbols'
import type {
  IndexCatalogRow,
  IndexCategory,
  IndexLatestResult,
  IndexLatestSortField,
} from '@/components/symbols/a-shares-index/types'

/**
 * A 股指数日线 API（统一表 index_daily_quotes，全 category）。
 *
 * 对应后端：
 *  - GET /api/indices/latest          → IndexDailyService.getLatest
 *  - GET /api/index-daily             → IndexDailyService.getKlines
 *  - GET /api/index-catalog           → IndexCatalogQueryService.findAll
 *
 * 与旧 /api/ths-index-daily（薄封装，仅 industry/concept，给 money-flow）区分：
 * 本模块给「A 股指数」二级 TAB，全 category（含大盘 market）。
 */
export interface IndexLatestQuery {
  /** 类型筛选，缺省返回四类合并 */
  type?: IndexCategory
  /** 申万层级过滤（仅 type='sw' 时使用）：1=一级、2=二级、3=三级 */
  level?: 1 | 2 | 3
  /** name 模糊搜索（ILIKE） */
  q?: string
  sort?: IndexLatestSortField
  /** 'asc' | 'desc'，缺省后端按 desc */
  order?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface IndexKlineQuery {
  /** 指数代码，如 000001.SH / 881101.TI */
  ts_code: string
  /** 起始日期 YYYYMMDD（含） */
  start_date: string
  /** 结束日期 YYYYMMDD（含） */
  end_date: string
}

export interface IndexCatalogQuery {
  category?: IndexCategory
  q?: string
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value))
  }
  const query = qs.toString()
  return query ? `?${query}` : ''
}

export const indexDailyApi = {
  /** 行情表最新行情（远程分页/排序/筛选）。 */
  getLatestList: (params: IndexLatestQuery) =>
    request<IndexLatestResult>(
      `${API_BASE}/indices/latest${buildQuery({
        type: params.type,
        level: params.level,
        q: params.q,
        sort: params.sort,
        order: params.order,
        page: params.page,
        pageSize: params.pageSize,
      })}`,
    ),

  /**
   * K 线（全 category）。返回 KlineChartBar[]：
   * open_time=YYYYMMDD 字面串、volume=「股」（后端已 ×100），
   * 与 money-flow 的 ths K 线同构，KlineChart 通用消费。
   */
  queryKline: (params: IndexKlineQuery) =>
    request<KlineChartBar[]>(
      `${API_BASE}/index-daily?ts_code=${encodeURIComponent(params.ts_code)}` +
        `&start_date=${params.start_date}&end_date=${params.end_date}`,
    ),

  /** 统一指数目录（类型筛选下拉/左侧列表）。 */
  getCatalog: (params: IndexCatalogQuery = {}) =>
    request<IndexCatalogRow[]>(
      `${API_BASE}/index-catalog${buildQuery({ category: params.category, q: params.q })}`,
    ),

  /** 获取申万指数层级 */
  getSwHierarchy: (tsCode: string) =>
    request<any>(`${API_BASE}/index-catalog/sw/${encodeURIComponent(tsCode)}/hierarchy`),
}
