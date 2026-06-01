// apps/web/src/components/symbols/a-shares/aShareDetailFetcher.ts
//
// A 股详情 Drawer 取数函数：K 线主图 + 资金流副图。
// 与 trendFetchers.ts 同构：把 fetcher 独立成模块便于 vitest 直接 import 单测，
// 同时让 <script setup> 内部仅保留 watch / loading / 错误提示等 UX 逻辑。
//
// 取数语义：并行拉取 K 线与个股资金流；由 mergeKlineWithMoneyFlow 把资金流
// 按日期合并到 K 线每根 bar 的 moneyFlow 字段。priceMode 切换路径只重拉
// K 线，资金流由 Drawer 缓存原始 flowRows 后重新 merge。

import { aSharesApi, type AShareKlineBar } from '@/api/modules/market/aShares'
import { moneyFlowApi } from '@/api/modules/market/moneyFlow'
import { activeMvApi, type AmvSeriesRow } from '@/api/modules/market/active-mv'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'

export interface AShareDetailFetchResult {
  /** 已 merge moneyFlow + AMV 的 K 线数组，每根 bar 自带 row.moneyFlow / '0AMV' 等 */
  kline: AShareKlineBar[]
  /** 透出 raw 资金流行，供 priceMode 切换路径复用（重 merge 不重拉） */
  flowRows: MoneyFlowRowLike[]
  /** 透出 AMV 序列，供 priceMode 切换路径复用（重 merge 不重拉） */
  amvRows: AmvSeriesRow[]
}

/** Drawer 首次加载 / 切换 row 时调用：并行拉 K 线 + 资金流 + 活跃市值 */
export async function fetchAShareDetail(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareDetailFetchResult> {
  const [kline, flowRows, amvRows] = await Promise.all([
    aSharesApi.getKlines(tsCode, limit, priceMode),
    moneyFlowApi.queryStocks({ ts_code: tsCode, limit }),
    // AMV 失败不应拖垮 K 线主图：吞错降级为空序列（副图缺日填 null）
    activeMvApi.getStock(tsCode, limit).catch(() => [] as AmvSeriesRow[]),
  ])
  return {
    kline: mergeKlineWithAmv(mergeKlineWithMoneyFlow(kline, flowRows), amvRows),
    flowRows,
    amvRows,
  }
}

/** priceMode 切换时调用：只重拉 K 线，资金流 / AMV 由调用方缓存复用 */
export async function fetchAShareKlineOnly(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareKlineBar[]> {
  return aSharesApi.getKlines(tsCode, limit, priceMode)
}
