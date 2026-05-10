export interface KpiCardItem {
  label: string
  value: string | null | undefined
  sub?: string
  /** 金额(amount)显示为亿、百分比(percent)显示为%、数量(count)显示为整数 */
  format?: 'amount' | 'percent' | 'count'
}

export interface BarChartRow {
  label: string
  value: number
}
