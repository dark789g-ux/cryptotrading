// apps/web/src/api/modules/market/active-mv.ts
//
// 活跃市值（AMV）API client。后端 spec §7：
//   GET  /api/active-mv/stock/:tsCode?days=250
//   GET  /api/active-mv/industry/:tsCode?days=250
//   GET  /api/active-mv/stock/signals?tradeDate=
//   GET  /api/active-mv/industry/signals?tradeDate=
//   POST /api/active-mv/{stock,industry}/sync
//
// 返回字段为驼峰（与后端 AmvSeriesRow / AmvSignalRow 对齐），trade_date 为 'YYYYMMDD'。

import { API_BASE, post, request } from '../../client'

/** 三态信号：多头 +1 / 中性 0 / 空头 -1 */
export type AmvSignal = -1 | 0 | 1

/** GET /active-mv/{stock,industry}/:tsCode 返回单行（与后端 AmvSeriesRow 对齐） */
export interface AmvSeriesRow {
  /** 'YYYYMMDD'（Tushare 标准） */
  tradeDate: string
  amvOpen: number
  amvHigh: number
  amvLow: number
  amvClose: number
  amvDif: number
  amvDea: number
  amvMacd: number
  amvZdf: number | null
  signal: AmvSignal
  /** 行业专用：当日有 amount 的成分股数；个股忽略 */
  memberCount?: number
}

/** GET /active-mv/{stock,industry}/signals?tradeDate= 返回单行 */
export interface AmvSignalRow {
  tsCode: string
  tradeDate: string
  amvDif: number
  amvMacd: number
  signal: AmvSignal
  memberCount?: number
}

export interface AmvSyncParams {
  startDate?: string
  endDate?: string
  syncMode?: 'incremental' | 'overwrite'
  /** 个股：可选指定个股代码；行业：可选指定行业指数代码（.TI） */
  tsCodes?: string[]
}

export interface AmvSyncResult {
  synced: number
  errors?: string[]
  failedItems?: Array<{ tsCode: string; apiName: string; reason?: string }>
}

export const activeMvApi = {
  // ---- 个股 ----
  getStock: (tsCode: string, days = 250) =>
    request<AmvSeriesRow[]>(
      `${API_BASE}/active-mv/stock/${encodeURIComponent(tsCode)}?days=${days}`,
    ),
  getStockSignals: (tradeDate: string) =>
    request<AmvSignalRow[]>(
      `${API_BASE}/active-mv/stock/signals?tradeDate=${encodeURIComponent(tradeDate)}`,
    ),
  syncStock: (params: AmvSyncParams = {}) =>
    post<AmvSyncResult>(`${API_BASE}/active-mv/stock/sync`, params),

  // ---- 行业 ----
  getIndustry: (tsCode: string, days = 250) =>
    request<AmvSeriesRow[]>(
      `${API_BASE}/active-mv/industry/${encodeURIComponent(tsCode)}?days=${days}`,
    ),
  getIndustrySignals: (tradeDate: string) =>
    request<AmvSignalRow[]>(
      `${API_BASE}/active-mv/industry/signals?tradeDate=${encodeURIComponent(tradeDate)}`,
    ),
  syncIndustry: (params: AmvSyncParams = {}) =>
    post<AmvSyncResult>(`${API_BASE}/active-mv/industry/sync`, params),

  // ---- 概念板块（同花顺 type='N'，独立表 concept_amv_daily / 独立端点） ----
  getConcept: (tsCode: string, days = 250) =>
    request<AmvSeriesRow[]>(
      `${API_BASE}/active-mv/concept/${encodeURIComponent(tsCode)}?days=${days}`,
    ),
  getConceptSignals: (tradeDate: string) =>
    request<AmvSignalRow[]>(
      `${API_BASE}/active-mv/concept/signals?tradeDate=${encodeURIComponent(tradeDate)}`,
    ),
  syncConcept: (params: AmvSyncParams = {}) =>
    post<AmvSyncResult>(`${API_BASE}/active-mv/concept/sync`, params),
}
