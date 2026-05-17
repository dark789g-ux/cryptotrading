import type { KlineChartBar } from '@/api'

/** 把任意日期字符串归一为无短横的 'YYYYMMDD'，作为合并 key。 */
function normalizeDateKey(s: string): string {
  // 用全局正则替代 replaceAll，避免 lib 需要 ES2021（项目 tsconfig 继承
  // @vue/tsconfig/dom 默认未含 ES2021）。语义等价。
  return s.replace(/-/g, '')
}

/** 后端资金流行的最小字段需求（接受 trendFetchers / aShareDetailFetcher 的 raw 行）。 */
export interface MoneyFlowRowLike {
  tradeDate: string                 // 'YYYYMMDD'
  netAmount: string | number | null // 已由后端 toYi() 转为亿元
}

/**
 * 把资金流 raw 行合并进 K 线数组，返回挂载了 moneyFlow 字段的新 K 线数组。
 *
 * 输入 K 线数组原样保留顺序（按 trade_date ASC），不修改原对象（spread 新建）。
 *
 * @param kline K 线数组，open_time 字符串格式由各后端 service 决定
 *              （行业：'YYYYMMDD'；A 股：'YYYY-MM-DD'）
 * @param flowRows 资金流原始行（trade_date DESC 或任意顺序均可），netAmount 已是亿元
 * @returns 同构 K 线数组，每根 bar 新增 moneyFlow: number | null
 */
export function mergeKlineWithMoneyFlow<T extends KlineChartBar>(
  kline: T[],
  flowRows: MoneyFlowRowLike[],
): T[] {
  const flowMap = new Map<string, number>(
    flowRows.map(r => [normalizeDateKey(r.tradeDate), Number(r.netAmount) || 0]),
  )

  const merged = kline.map(bar => ({
    ...bar,
    moneyFlow: flowMap.get(normalizeDateKey(bar.open_time)) ?? null,
  }))

  // R3 探针：dev 模式下，flowRows 非空但合并后 0 命中 → 强烈暗示格式不一致
  if (import.meta.env.DEV && flowRows.length > 0 && kline.length > 0) {
    const matched = merged.filter(b => b.moneyFlow != null).length
    if (matched === 0) {
      console.error(
        '[mergeKlineWithMoneyFlow] 资金流非空但与 K 线 0 命中，疑似日期格式不一致。',
        {
          klineLen: kline.length,
          flowLen: flowRows.length,
          sampleKlineOpenTime: kline[0]?.open_time,
          sampleFlowTradeDate: flowRows[0]?.tradeDate,
        },
      )
    }
  }

  return merged
}
