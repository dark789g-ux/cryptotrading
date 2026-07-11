/** Hub 统一列表行的市场标识 */
export type BacktestMarket = 'ashare' | 'crypto'

export type HubMarketFilter = 'all' | BacktestMarket

export interface HubBacktestRow {
  key: string
  id: string
  market: BacktestMarket
  name: string
  /** 副标题：区间 / 周期等 */
  subtitle: string
  statusLabel: string
  statusType: 'default' | 'info' | 'success' | 'error'
  /** 主指标文案（收益率等） */
  metric: string
  createdAt: string
  createdAtMs: number
}
