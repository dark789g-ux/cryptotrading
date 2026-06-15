import { API_BASE, put, request } from '../../client'

export interface ColumnPreferenceItem {
  key: string
  visible: boolean
}

export interface SymbolsViewColumnPreferences {
  crypto: ColumnPreferenceItem[]
  aShares: ColumnPreferenceItem[]
  usStocks: ColumnPreferenceItem[]
}

export const preferencesApi = {
  getSymbolsView: () => request<SymbolsViewColumnPreferences>(`${API_BASE}/preferences/symbols-view`),
  saveSymbolsView: (body: SymbolsViewColumnPreferences) =>
    put<{ ok: true }>(`${API_BASE}/preferences/symbols-view`, body),
}
