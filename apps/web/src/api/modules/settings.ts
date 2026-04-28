import { API_BASE, put, request } from '../client'

export const settingsApi = {
  getExcluded: () => request<string[]>(`${API_BASE}/settings/excluded-symbols`),
  setExcluded: (symbols: string[]) => put<{ ok: true }>(`${API_BASE}/settings/excluded-symbols`, { symbols }),
  getAllConfigs: () => request<Record<string, unknown>>(`${API_BASE}/settings/config`),
  setConfig: (key: string, value: unknown) => put<{ ok: true }>(`${API_BASE}/settings/config/${key}`, { value }),
}
