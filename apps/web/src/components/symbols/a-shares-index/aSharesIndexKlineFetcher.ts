import { indexDailyApi } from '@/api/modules/market/indexDaily'
import { customIndexApi } from '@/api/modules/market/customIndex'
import { activeMvApi, type AmvSeriesRow } from '@/api/modules/market/active-mv'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'
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
 * A 股指数 K 线 Modal 取数：并行拉 K 线与 AMV，按 trade_date 合并。
 * category=market 不请求 AMV；category=custom 走 custom-indices API。
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

  const [kline, amvRows] = await Promise.all([klinePromise, amvPromise])
  return mergeKlineWithAmv(kline, amvRows)
}
