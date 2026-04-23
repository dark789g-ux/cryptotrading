export type StatusFilterValue = 'buy' | 'sell' | 'hold'

export interface RunSymbolMetricCondition {
  field: string
  op: string
  value: number
}

export const STATUS_BUY: StatusFilterValue = 'buy'
export const STATUS_SELL: StatusFilterValue = 'sell'
export const STATUS_HOLD: StatusFilterValue = 'hold'

export const DEFAULT_STATUS_VALUES: StatusFilterValue[] = [STATUS_BUY, STATUS_SELL, STATUS_HOLD]

export const statusFilterOptions: Array<{ label: string; value: StatusFilterValue }> = [
  { label: '本根买入', value: STATUS_BUY },
  { label: '本根卖出', value: STATUS_SELL },
  { label: '本根持有', value: STATUS_HOLD },
]

export const opOptions: Array<{ label: string; value: string }> = [
  { label: '大于', value: 'gt' },
  { label: '小于', value: 'lt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于等于', value: 'lte' },
]

export const opLabels: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' }
