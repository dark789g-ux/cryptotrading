import { API_BASE, put, request } from '../client'

export interface SyncPreferences {
  intervals: string[]
  symbols: string[]
}

export interface KlineDateRange {
  min: string | null
  max: string | null
}

export type CryptoSyncMode = 'incremental' | 'overwrite'

export const syncApi = {
  getPreferences: () =>
    request<SyncPreferences>(`${API_BASE}/sync/preferences`),

  savePreferences: (body: SyncPreferences) =>
    put<SyncPreferences>(`${API_BASE}/sync/preferences`, body),

  getDateRange: () =>
    request<KlineDateRange>(`${API_BASE}/sync/date-range`),

  syncRunUrl(params: {
    startDate?: string
    endDate?: string
    syncMode?: CryptoSyncMode
  } = {}): string {
    const qs = new URLSearchParams()
    if (params.startDate) qs.set('startDate', params.startDate)
    if (params.endDate) qs.set('endDate', params.endDate)
    if (params.syncMode) qs.set('syncMode', params.syncMode)
    const s = qs.toString()
    return `${API_BASE}/sync/run${s ? `?${s}` : ''}`
  },
}
