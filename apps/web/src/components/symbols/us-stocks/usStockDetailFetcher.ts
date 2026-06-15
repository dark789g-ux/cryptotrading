// apps/web/src/components/symbols/us-stocks/usStockDetailFetcher.ts
//
// 美股详情 Drawer 取数函数：K 线主图（含技术指标副图）。
// 与 a-shares/aShareDetailFetcher.ts 同构，但美股无资金流 / 无活跃市值（AMV），
// 故只拉 K 线，不做 moneyFlow / AMV merge。独立成模块便于 vitest 直接 import 单测。

import { usStocksApi, type UsStockKlineBar } from '@/api/modules/market/usStocks'

/** Drawer 首次加载 / 切换 row / priceMode 切换时调用：拉美股 K 线 */
export async function fetchUsStockKline(
  ticker: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<UsStockKlineBar[]> {
  return usStocksApi.getKlines(ticker, limit, priceMode)
}
