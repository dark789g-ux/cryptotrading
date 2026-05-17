import type { KlineChartBar, MoneyFlowBar } from '@/api'

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

/**
 * 行业 / 板块 详情 Modal 趋势 Tab 的合并取数结果。
 * - kline: 同花顺指数 K 线（来自 GET /ths-index-daily）
 * - moneyFlow: 资金净流入柱状副图数据（来自 GET /money-flow/{industries|sectors}）
 */
export interface TrendFetchResult {
  kline: KlineChartBar[]
  moneyFlow: MoneyFlowBar[]
}
