import { API_BASE, post, request } from '../../client'

export interface OamvDateRange {
  min: string | null
  max: string | null
}

export interface OamvSyncParams {
  startDate?: string
  endDate?: string
  syncMode?: 'incremental' | 'overwrite'
}

export interface OamvSyncResult {
  success: boolean
  synced: number
}

export interface OamvData {
  id: string
  tradeDate: string
  open: string
  high: string
  low: string
  close: string
  createdAt: string
  // MACD 三线（后端已落库，顺带补上）
  amvDif?: number | null
  amvDea?: number | null
  amvMacd?: number | null
  // MA 均线
  ma5?: number | null
  ma30?: number | null
  ma60?: number | null
  ma120?: number | null
  ma240?: number | null
  // KDJ
  kdjK?: number | null
  kdjD?: number | null
  kdjJ?: number | null
}

export const oamvApi = {
  getDateRange(): Promise<OamvDateRange> {
    return request<OamvDateRange>(`${API_BASE}/oamv/date-range`)
  },

  sync(params: OamvSyncParams = {}): Promise<OamvSyncResult> {
    return post<OamvSyncResult>(`${API_BASE}/oamv/sync`, params)
  },

  getData(days: number = 250): Promise<OamvData[]> {
    return request<OamvData[]>(`${API_BASE}/oamv/data?days=${days}`)
  },
}
