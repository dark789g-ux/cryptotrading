import { API_BASE } from '../../client'

export interface BaseDataSyncParams {
  start_date: string
  end_date: string
  syncMode: 'incremental' | 'overwrite'
}

// 基础数据（trade_cal / stk_limit / suspend_d）同步 API client。
// 仿 moneyFlow.ts：syncRunUrl 拼 SSE GET URL，rangeUrl 取库存范围。
// 后端契约见 docs/superpowers/specs/2026-06-08-base-data-sync-frontend-design/01-architecture.md
export const baseDataSyncApi = {
  syncRunUrl: (params: BaseDataSyncParams): string => {
    const qs = new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
      syncMode: params.syncMode,
    })
    return `${API_BASE}/base-data/sync/run?${qs.toString()}`
  },

  rangeUrl: (): string => `${API_BASE}/base-data/range`,
}
