import { API_BASE, put, request } from '../../client'

export interface ColumnPreferenceItem {
  key: string
  visible: boolean
}

/** 单个 scope 下按视图（表格 / 分栏）分层的列偏好。 */
export interface ScopeViewPreferences {
  table: ColumnPreferenceItem[]
  split: ColumnPreferenceItem[]
}

export interface SymbolsViewColumnPreferences {
  crypto: ScopeViewPreferences
  aShares: ScopeViewPreferences
  usStocks: ScopeViewPreferences
  aSharesIndex: ScopeViewPreferences
  aSharesIndexSw: ScopeViewPreferences
}

export const preferencesApi = {
  getSymbolsView: () => request<SymbolsViewColumnPreferences>(`${API_BASE}/preferences/symbols-view`),
  saveSymbolsView: (body: SymbolsViewColumnPreferences) =>
    put<{ ok: true }>(`${API_BASE}/preferences/symbols-view`, body),
}
