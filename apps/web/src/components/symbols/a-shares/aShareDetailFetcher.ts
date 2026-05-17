// apps/web/src/components/symbols/a-shares/aShareDetailFetcher.ts
//
// A 股详情 Drawer 取数函数：K 线主图 + 资金流副图。
// 与 trendFetchers.ts 同构：把 fetcher 独立成模块便于 vitest 直接 import 单测，
// 同时让 <script setup> 内部仅保留 watch / loading / 错误提示等 UX 逻辑。

import { aSharesApi, type AShareKlineBar } from '@/api/modules/market/aShares'
import { moneyFlowApi, type MoneyFlowStockRow } from '@/api/modules/market/moneyFlow'
import type { MoneyFlowBar } from '@/api/modules/market/symbols'

export interface AShareDetailFetchResult {
  kline: AShareKlineBar[]
  moneyFlow: MoneyFlowBar[]
}

/** Drawer 首次加载 / 切换 row 时调用：并行拉 K 线 + 资金流 */
export async function fetchAShareDetail(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareDetailFetchResult> {
  const [kline, flowRows] = await Promise.all([
    aSharesApi.getKlines(tsCode, limit, priceMode),
    moneyFlowApi.queryStocks({ ts_code: tsCode, limit }),
  ])
  return { kline, moneyFlow: mapMoneyFlowBars(flowRows) }
}

/** priceMode 切换时调用：只重拉 K 线，资金流由调用方缓存复用 */
export async function fetchAShareKlineOnly(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareKlineBar[]> {
  return aSharesApi.getKlines(tsCode, limit, priceMode)
}

/**
 * 把后端 MoneyFlowStockRow 映射为 KlineChart 副图所需的 MoneyFlowBar。
 * - 后端 service 在传 limit 时按 trade_date DESC 返回，K 线主图是 ASC 显示，需要 reverse。
 * - netAmount 已由后端 toYi() 转为亿元（万元 ÷ 10000），前端不再换算。
 * - null/NaN 回退为 0，与 trendFetchers.fetchIndustryTrend 一致。
 */
export function mapMoneyFlowBars(rows: MoneyFlowStockRow[]): MoneyFlowBar[] {
  return rows
    .slice()
    .reverse()
    .map(r => ({
      trade_date: r.tradeDate,
      net_amount: Number(r.netAmount) || 0,
    }))
}
