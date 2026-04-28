import { API_BASE, del, post, put, request } from '../client'

export interface SymbolPreset {
  id: string
  name: string
  symbols: string[]
  createdAt: string
}

export const symbolPresetApi = {
  list: () => request<SymbolPreset[]>(`${API_BASE}/symbol-presets`),
  create: (body: { name: string; symbols: string[] }) =>
    post<SymbolPreset>(`${API_BASE}/symbol-presets`, body),
  update: (id: string, body: { name?: string; symbols?: string[] }) =>
    put<SymbolPreset>(`${API_BASE}/symbol-presets/${id}`, body),
  delete: (id: string) => del<{ ok: true }>(`${API_BASE}/symbol-presets/${id}`),
}
