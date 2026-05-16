import { API_BASE, request } from '../../client'
import type { KlineChartBar } from './symbols'

export interface ThsIndexDailyQuery {
  ts_code: string
  start_date: string
  end_date: string
}

export interface ThsIndexDailyDateRange {
  min: string | null
  max: string | null
}

export const thsIndexDailyApi = {
  query: (params: ThsIndexDailyQuery) =>
    request<KlineChartBar[]>(
      `${API_BASE}/ths-index-daily?ts_code=${encodeURIComponent(params.ts_code)}` +
        `&start_date=${params.start_date}&end_date=${params.end_date}`,
    ),

  getDateRange: () =>
    request<ThsIndexDailyDateRange>(`${API_BASE}/ths-index-daily/date-range`),
}
