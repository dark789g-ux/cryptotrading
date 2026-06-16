import { API_BASE, post, request } from '../../client'
import type { KlineChartBar } from './symbols'

export interface UsIndexDailyQuery {
  index_code: string
  start_date: string
  end_date: string
}

export interface UsIndexDailyDateRange {
  start: string | null
  end: string | null
}

export interface UsIndexSyncBody {
  dateRange?: [string, string]
  symbols?: string[]
}

export const usIndexDailyApi = {
  query: (params: UsIndexDailyQuery) =>
    request<KlineChartBar[]>(
      `${API_BASE}/us-index-daily?index_code=${encodeURIComponent(params.index_code)}` +
        `&start_date=${params.start_date}&end_date=${params.end_date}`,
    ),

  getDateRange: (index_code: string) =>
    request<UsIndexDailyDateRange>(
      `${API_BASE}/us-index-daily/date-range?index_code=${encodeURIComponent(index_code)}`,
    ),

  // POST /sync to write one ml.jobs row (run_type='us_index_sync'), returns jobId;
  // frontend reuses quant jobs SSE to track progress. Empty body lets worker default to full + ('.NDX',).
  triggerSync: (body: UsIndexSyncBody = {}) =>
    post<{ jobId: string }>(`${API_BASE}/us-index-daily/sync`, body),
}
