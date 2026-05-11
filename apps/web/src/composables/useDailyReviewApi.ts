import { request, post, del } from '@/api/client'
import type { DailyReviewListItem } from '@/types/daily-review'

export function useDailyReviewApi() {
  return {
    list: (params: { status?: string; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams()
      if (params.status) qs.set('status', params.status)
      if (params.page) qs.set('page', String(params.page))
      if (params.pageSize) qs.set('pageSize', String(params.pageSize))
      const query = qs.toString()
      return request<{ items: DailyReviewListItem[]; total: number; page: number; pageSize: number }>(
        `/api/daily-review${query ? `?${query}` : ''}`,
      )
    },
    detail: (tradeDate: string) => request<any>(`/api/daily-review/${tradeDate}`),
    create: (tradeDate?: string) =>
      post<{ tradeDate: string; status: string }>('/api/daily-review', { tradeDate }),
    remove: (tradeDate: string) => del<{ ok: boolean }>(`/api/daily-review/${tradeDate}`),
  }
}
