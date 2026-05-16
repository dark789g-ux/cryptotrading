// apps/web/src/components/money-flow/trendFetchers.ts
//
// 行业 / 板块 详情 Modal 趋势 Tab 的取数函数。
// 抽到独立模块的目的：
// 1. <script setup> 中导出顶层命名函数与单测工具链兼容性较差
// 2. 单测可以直接 import 这两个 fetcher 验证「Promise.all 并发 + 字段命名映射」
//
// 取数语义：并行拉取 ths_index_daily K 线与 money-flow 净流入，
// 后者映射为 KlineChart 的 MoneyFlowBar 形态（trade_date / net_amount）。

import { moneyFlowApi, type MoneyFlowQueryParams } from '@/api/modules/market/moneyFlow'
import { thsIndexDailyApi } from '@/api/modules/market/thsIndexDaily'
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
  const [kline, flow] = await Promise.all([
    thsIndexDailyApi.query(ranged),
    moneyFlowApi.queryIndustries(params),
  ])
  return {
    kline,
    moneyFlow: flow.map(r => ({
      trade_date: r.tradeDate,
      net_amount: Number(r.netAmount) || 0,
    })),
  }
}

export async function fetchSectorTrend(params: MoneyFlowQueryParams): Promise<TrendFetchResult> {
  const ranged = requireDateRange(params)
  const [kline, flow] = await Promise.all([
    thsIndexDailyApi.query(ranged),
    moneyFlowApi.querySectors(params),
  ])
  return {
    kline,
    moneyFlow: flow.map(r => ({
      trade_date: r.tradeDate,
      net_amount: Number(r.netAmount) || 0,
    })),
  }
}
