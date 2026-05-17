import type { KlineChartBar } from '@/api'

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
 * - kline: 同花顺指数 K 线，已通过 `mergeKlineWithMoneyFlow` 把资金净流入
 *   挂载到每根 bar 的 `moneyFlow` 字段；KlineChart 副图直读行内字段。
 */
export interface TrendFetchResult {
  kline: KlineChartBar[]
}
