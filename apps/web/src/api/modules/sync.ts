import { API_BASE, put, request } from '../client'

export interface SyncPreferences {
  intervals: string[]
  symbols: string[]
}

export const syncApi = {
  getPreferences: () => request<SyncPreferences>(`${API_BASE}/sync/preferences`),
  savePreferences: (body: SyncPreferences) =>
    put<SyncPreferences>(`${API_BASE}/sync/preferences`, body),
}
