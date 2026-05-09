import { API_BASE, post, request } from '../client'

export interface OamvData {
  id: string
  tradeDate: string
  open: string
  high: string
  low: string
  close: string
  createdAt: string
}

export interface OamvSyncResult {
  success: boolean
  synced: number
}

export const oamvApi = {
  /**
   * 同步 0AMV 数据
   */
  sync(): Promise<OamvSyncResult> {
    return post<OamvSyncResult>(`${API_BASE}/oamv/sync`)
  },

  /**
   * 获取 0AMV 数据
   */
  getData(days: number = 250): Promise<OamvData[]> {
    return request<OamvData[]>(`${API_BASE}/oamv/data?days=${days}`)
  },
}
