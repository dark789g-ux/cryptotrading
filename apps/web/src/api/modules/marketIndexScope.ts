import { API_BASE, post, request } from '../client'

/**
 * 大盘宽基动态范围管理 API。
 *
 * 对应后端 MarketIndexScopeController（MK-T1，commit 72c000a）：
 * - GET  /api/market-index-scope/discover  发现候选
 * - GET  /api/market-index-scope           当前范围
 * - POST /api/market-index-scope/add       加入范围
 * - POST /api/market-index-scope/remove    移出范围
 *
 * 字段镜像后端 service 导出的接口（snake_case，与 DTO/实体一致），勿改大小写。
 */

/** 噪声标签（镜像后端 classifyNoise.NoiseTag）。前三种「隐藏疑似噪声」开关默认隐藏。 */
export type MarketIndexNoiseTag =
  | 'delisted'      // 已退市
  | 'cross_border'  // 跨境/外币/新三板
  | 'total_return'  // 收益版
  | 'duplicate'     // 多挂牌次挂牌
  | 'small_cap'     // 中小盘（仅提醒，不隐藏）

/** discoverCandidates 返回的单条候选（镜像 MarketIndexCandidate）。 */
export interface MarketIndexCandidate {
  ts_code: string
  name: string
  exp_date: string | null
  category: string
  noise_tags: MarketIndexNoiseTag[]
  in_scope: boolean
}

/** getScope 返回的单条范围行（镜像 MarketIndexScopeRow）。 */
export interface MarketIndexScopeRow {
  ts_code: string
  name: string
}

/** discoverCandidates 结果（候选 + 失败项透出，遵循 data-integrity 规范）。 */
export interface MarketIndexDiscoverResult {
  candidates: MarketIndexCandidate[]
  failedItems: string[]
}

/** 「隐藏疑似噪声」开关默认隐藏的噪声标签（spec 04 §4.4）。 */
export const HIDDEN_NOISE_TAGS: ReadonlySet<MarketIndexNoiseTag> = new Set([
  'delisted',
  'cross_border',
  'total_return',
])

export const marketIndexScopeApi = {
  discover: () =>
    request<MarketIndexDiscoverResult>(`${API_BASE}/market-index-scope/discover`),
  list: () =>
    request<MarketIndexScopeRow[]>(`${API_BASE}/market-index-scope`),
  add: (tsCode: string, name: string) =>
    post<void>(`${API_BASE}/market-index-scope/add`, { tsCode, name }),
  remove: (tsCode: string) =>
    post<void>(`${API_BASE}/market-index-scope/remove`, { tsCode }),
}
