export interface KpiCardItem {
  label: string
  value: string | null | undefined
  sub?: string
}

export interface BarChartRow {
  label: string
  value: number
}
