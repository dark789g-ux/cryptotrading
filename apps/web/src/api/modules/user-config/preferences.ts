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

export const preferencesApi = {
  getTableColumns: (tableId: string) =>
    request<ScopeViewPreferences>(`${API_BASE}/preferences/columns/${tableId}`),
  saveTableColumns: (tableId: string, body: ScopeViewPreferences) =>
    put<{ ok: true }>(`${API_BASE}/preferences/columns/${tableId}`, body),
}
