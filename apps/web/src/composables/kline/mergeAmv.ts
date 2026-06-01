import type { KlineChartBar } from '@/api'
import type { AmvSeriesRow } from '@/api/modules/market/active-mv'

/**
 * 把任意日期字符串归一为无短横的 'YYYYMMDD'，作为合并 key。
 *
 * 两侧契约（datetime 规则）：
 * - AMV 行 tradeDate 为 'YYYYMMDD'；
 * - K 线 open_time 为 'YYYY-MM-DD'（A 股）或 'YYYYMMDD'（行业指数）。
 * 统一去短横后字面相等比对，缺日填 null，绝不容忍其它格式漂移。
 */
function normalizeDateKey(s: string): string {
  return s.replace(/-/g, '')
}

/**
 * 把 AMV 序列合并进 K 线数组，返回挂载了 '0AMV' / '0AMV.DIF/DEA/MACD' 字段的新数组。
 *
 * - 输入 K 线顺序原样保留（按 trade_date ASC），不修改原对象（spread 新建）。
 * - 命中：写入 amvClose → '0AMV'，amvDif/amvDea/amvMacd → 对应点号字段。
 * - 未命中（停牌 / 热身裁掉 / 缺日）：四个字段全填 null。
 *
 * @param kline   K 线数组，open_time 字符串格式由各后端 service 决定
 * @param amvRows AMV 序列（trade_date 任意顺序），字段为驼峰
 */
export function mergeKlineWithAmv<T extends KlineChartBar>(
  kline: T[],
  amvRows: AmvSeriesRow[],
): T[] {
  const amvMap = new Map<string, AmvSeriesRow>(
    amvRows.map((r) => [normalizeDateKey(r.tradeDate), r]),
  )

  const merged = kline.map((bar) => {
    const row = amvMap.get(normalizeDateKey(bar.open_time))
    return {
      ...bar,
      '0AMV': row ? row.amvClose : null,
      '0AMV.DIF': row ? row.amvDif : null,
      '0AMV.DEA': row ? row.amvDea : null,
      '0AMV.MACD': row ? row.amvMacd : null,
    }
  })

  // dev 探针：amvRows 非空但 0 命中 → 强烈暗示两接口日期格式不一致
  if (import.meta.env.DEV && amvRows.length > 0 && kline.length > 0) {
    const matched = merged.filter((b) => b['0AMV'] != null).length
    if (matched === 0) {
      console.error(
        '[mergeKlineWithAmv] AMV 非空但与 K 线 0 命中，疑似日期格式不一致。',
        {
          klineLen: kline.length,
          amvLen: amvRows.length,
          sampleKlineOpenTime: kline[0]?.open_time,
          sampleAmvTradeDate: amvRows[0]?.tradeDate,
        },
      )
    }
  }

  return merged
}
