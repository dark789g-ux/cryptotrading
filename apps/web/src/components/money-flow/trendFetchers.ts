// apps/web/src/components/money-flow/trendFetchers.ts
//
// 行业 / 板块 详情 Modal 趋势 Tab 的取数函数。
// 抽到独立模块的目的：
// 1. <script setup> 中导出顶层命名函数与单测工具链兼容性较差
// 2. 单测可以直接 import 这两个 fetcher 验证「Promise.all 并发 + 合并语义」
//
// 取数语义：并行拉取 ths_index_daily K 线与 money-flow 净流入，
// 由 mergeKlineWithMoneyFlow 把资金流按日期合并到 K 线每根 bar 的
// moneyFlow 字段，KlineChart 副图按 index 直读，不再依赖两数组对齐。

import { moneyFlowApi, type MoneyFlowQueryParams } from '@/api/modules/market/moneyFlow'
import { thsIndexDailyApi } from '@/api/modules/market/thsIndexDaily'
import { activeMvApi, type AmvSeriesRow } from '@/api/modules/market/active-mv'
import { mergeKlineWithMoneyFlow } from '@/composables/kline/mergeMoneyFlow'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'
import type { TrendFetchResult } from './money-flow.types'

function requireDateRange(params: MoneyFlowQueryParams): { ts_code: string; start_date: string; end_date: string } {
  // chart-mode=kline 下 FlowDateControl 已强制 range 模式且默认 120 天，
  // 因此 start_date / end_date / ts_code 一定都有；这里只是给 TS 一个非空收口。
  if (!params.ts_code || !params.start_date || !params.end_date) {
    throw new Error('kline 模式下 trendFetchFn 需要 ts_code/start_date/end_date 同时存在')
  }
  return { ts_code: params.ts_code, start_date: params.start_date, end_date: params.end_date }
}

export async function fetchIndustryTrend(params: MoneyFlowQueryParams): Promise<TrendFetchResult> {
  const ranged = requireDateRange(params)
  // 行业指数（type='I'，.TI）：并行拉 K 线 + 资金流 + 活跃市值（AMV）。
  // AMV 走 days 口径（这里取近 250 交易日），失败降级空序列（副图缺日填 null），
  // 不拖垮 K 线主图。
  const [kline, flowRows, amvRows] = await Promise.all([
    thsIndexDailyApi.query(ranged),
    moneyFlowApi.queryIndustries(params),
    activeMvApi.getIndustry(ranged.ts_code, 250).catch(() => [] as AmvSeriesRow[]),
  ])
  return {
    kline: mergeKlineWithAmv(mergeKlineWithMoneyFlow(kline, flowRows), amvRows),
  }
}

export async function fetchSectorTrend(params: MoneyFlowQueryParams): Promise<TrendFetchResult> {
  const ranged = requireDateRange(params)
  const [kline, flowRows] = await Promise.all([
    thsIndexDailyApi.query(ranged),
    moneyFlowApi.querySectors(params),
  ])
  return {
    kline: mergeKlineWithMoneyFlow(kline, flowRows),
  }
}
