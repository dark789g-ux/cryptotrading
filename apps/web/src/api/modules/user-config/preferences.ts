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

export interface SyncStepsPreference {
  steps: string[]
}

/** 后端返回/写入的 K 线偏好结构(字段全可选,缺省由前端 normalize) */
export interface KlinePrefsPayload {
  order?: string[]
  visibility?: Record<string, boolean>
  heightPct?: Record<string, number>
  params?: Record<string, unknown>
  mainIndicators?: Record<string, boolean>
}

export const preferencesApi = {
  getTableColumns: (tableId: string) =>
    request<ScopeViewPreferences>(`${API_BASE}/preferences/columns/${tableId}`),
  saveTableColumns: (tableId: string, body: ScopeViewPreferences) =>
    put<{ ok: true }>(`${API_BASE}/preferences/columns/${tableId}`, body),
  getSyncSteps: (scope: string) =>
    request<SyncStepsPreference>(`${API_BASE}/preferences/sync-steps/${scope}`),
  saveSyncSteps: (scope: string, body: SyncStepsPreference) =>
    put<{ ok: true }>(`${API_BASE}/preferences/sync-steps/${scope}`, body),
  getKlinePrefs: (prefsKey: string) =>
    request<KlinePrefsPayload>(`${API_BASE}/preferences/kline/${prefsKey}`),
  saveKlinePrefs: (prefsKey: string, body: KlinePrefsPayload) =>
    put<{ ok: true }>(`${API_BASE}/preferences/kline/${prefsKey}`, body),
}
