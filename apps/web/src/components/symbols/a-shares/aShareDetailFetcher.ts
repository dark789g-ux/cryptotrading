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
 * 把 'YYYYMMDD' 转 'YYYY-MM-DD'，以对齐 A 股 K 线 open_time 的格式。
 *
 * 背景：后端 a-shares.service.ts:221 在拼 K 线响应时用 formatTradeDateLabel
 * 把 trade_date 转成 'YYYY-MM-DD'；而个股资金流 money-flow.service.ts 直返
 * 数据库列原值 'YYYYMMDD'。两者格式不一致会导致 KlineChart 副图
 * flowMap.get(row.open_time) 永远 miss、柱形画不出（参见 spec § 4.2 排错记录）。
 *
 * 行业 Tab 没踩此坑是因为 ths-index-daily.service.ts:93 也直返 'YYYYMMDD'，
 * 行业 K 线 open_time 与 industries 资金流 tradeDate 凑巧同源。
 *
 * 非 8 位长度（已带短横、空串等）原样保留，避免破坏数据。
 */
function toIsoTradeDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

/**
 * 把后端 MoneyFlowStockRow 映射为 KlineChart 副图所需的 MoneyFlowBar。
 * - 后端 service 在传 limit 时按 trade_date DESC 返回，K 线主图是 ASC 显示，需要 reverse。
 * - trade_date 从 'YYYYMMDD' 转 'YYYY-MM-DD' 与 A 股 K 线 open_time 对齐（见 toIsoTradeDate）。
 * - netAmount 已由后端 toYi() 转为亿元（万元 ÷ 10000），前端不再换算。
 * - null/NaN 回退为 0，与 trendFetchers.fetchIndustryTrend 一致。
 */
export function mapMoneyFlowBars(rows: MoneyFlowStockRow[]): MoneyFlowBar[] {
  return rows
    .slice()
    .reverse()
    .map(r => ({
      trade_date: toIsoTradeDate(r.tradeDate),
      net_amount: Number(r.netAmount) || 0,
    }))
}
