import { indexDailyApi } from '@/api/modules/market/indexDaily'
import { customIndexApi } from '@/api/modules/market/customIndex'
import { activeMvApi, type AmvSeriesRow } from '@/api/modules/market/active-mv'
import { moneyFlowApi } from '@/api/modules/market/moneyFlow'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'
import type { IndexLatestRow } from './types'

async function fetchAmvForRow(
  row: IndexLatestRow,
  startDate: string,
  endDate: string,
): Promise<AmvSeriesRow[]> {
  const range = { startDate, endDate }
  switch (row.category) {
    case 'custom':
      if (!row.id) return []
      return customIndexApi.getAmv(row.id, startDate, endDate)
    case 'sw':
      return activeMvApi.getSw(row.tsCode, range)
    case 'industry':
      return activeMvApi.getIndustry(row.tsCode, range)
    case 'concept':
      return activeMvApi.getConcept(row.tsCode, range)
    default:
      return []
  }
}

async function fetchKlineForRow(
  row: IndexLatestRow,
  startDate: string,
  endDate: string,
): Promise<KlineChartBar[]> {
  if (row.category === 'custom') {
    if (!row.id) return []
    return customIndexApi.getKline(row.id, startDate, endDate)
  }
  return indexDailyApi.queryKline({
    ts_code: row.tsCode,
    start_date: startDate,
    end_date: endDate,
  })
}

/**
 * 按指数类型拉资金净流入时序（后端各表均已有聚合数据）。
 * 返回行满足 MoneyFlowRowLike（tradeDate + netAmount），netAmount 已是亿元。
 */
async function fetchMoneyFlowForRow(
  row: IndexLatestRow,
  startDate: string,
  endDate: string,
): Promise<MoneyFlowRowLike[]> {
  const params = { ts_code: row.tsCode, start_date: startDate, end_date: endDate }
  switch (row.category) {
    case 'market':
      // 宽基指数资金流（money_flow_index，成分股 PIT 聚合）
      return moneyFlowApi.queryIndices(params)
    case 'sw':
      // 申万行业（money_flow_industries）
      return moneyFlowApi.queryIndustries(params)
    case 'industry':
      // 同花顺行业（money_flow_ths_industries）
      return moneyFlowApi.queryThsIndustries(params)
    case 'concept':
      // 同花顺概念板块（money_flow_sectors）
      return moneyFlowApi.querySectors(params)
    case 'custom':
      if (!row.id) return []
      return customIndexApi.getMoneyFlow(row.id, startDate, endDate)
    default:
      return []
  }
}

/**
 * A 股指数 K 线 Modal 取数：并行拉 K 线 / AMV / 资金流，按 trade_date 合并。
 * category=market 不请求 AMV；category=custom 走 custom-indices API。
 * 资金流失败降级为空（FLOW 副图全空，不影响 K 线主图）。
 */
export async function fetchIndexKline(
  row: IndexLatestRow,
  startDate: string,
  endDate: string,
): Promise<KlineChartBar[]> {
  const klinePromise = fetchKlineForRow(row, startDate, endDate)

  const amvPromise =
    row.category === 'market'
      ? Promise.resolve([] as AmvSeriesRow[])
      : fetchAmvForRow(row, startDate, endDate).catch(() => [] as AmvSeriesRow[])

  const flowPromise = fetchMoneyFlowForRow(row, startDate, endDate).catch(
    () => [] as MoneyFlowRowLike[],
  )

  const [kline, amvRows, flowRows] = await Promise.all([klinePromise, amvPromise, flowPromise])
  return mergeKlineWithAmv(mergeKlineWithMoneyFlow(kline, flowRows), amvRows)
}
