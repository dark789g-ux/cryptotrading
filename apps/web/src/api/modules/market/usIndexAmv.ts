// apps/web/src/api/modules/market/usIndexAmv.ts
//
// 美股指数活跃市值（AMV）API client。后端 spec 05 契约：
//   GET  /api/us-index-amv?index_code=&start_date=&end_date=  -> AmvSeriesRow[]
//   GET  /api/us-index-amv/date-range?index_code=             -> {start,end}
//   POST /api/us-index-amv/sync                               -> {jobId}
//
// 复用 active-mv 的 AmvSeriesRow（后端 getSeries 返回严格同构，tradeDate='YYYYMMDD'）。
// 与 usIndexDaily.ts 同构：含 . 的 index_code 一律 encodeURIComponent。

import { API_BASE, post, request } from '../../client'
import type { AmvSeriesRow } from './active-mv'

export interface UsIndexAmvQuery {
  index_code: string
  start_date: string
  end_date: string
}

export interface UsIndexAmvDateRange {
  start: string | null
  end: string | null
}

export interface UsIndexAmvSyncBody {
  dateRange?: [string, string]
  symbols?: string[]
}

export const usIndexAmvApi = {
  query: (params: UsIndexAmvQuery) =>
    request<AmvSeriesRow[]>(
      `${API_BASE}/us-index-amv?index_code=${encodeURIComponent(params.index_code)}` +
        `&start_date=${params.start_date}&end_date=${params.end_date}`,
    ),

  getDateRange: (index_code: string) =>
    request<UsIndexAmvDateRange>(
      `${API_BASE}/us-index-amv/date-range?index_code=${encodeURIComponent(index_code)}`,
    ),

  // POST /sync writes one ml.jobs row (run_type='us_index_amv_sync'), returns jobId;
  // empty body lets the worker default to full range + ('.NDX',).
  triggerSync: (body: UsIndexAmvSyncBody = {}) =>
    post<{ jobId: string }>(`${API_BASE}/us-index-amv/sync`, body),
}
