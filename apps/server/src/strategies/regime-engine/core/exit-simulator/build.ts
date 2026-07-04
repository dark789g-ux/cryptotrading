/**
 * exit-simulator/build.ts
 *
 * 持有窗口构造：buildHoldingDays + findLastIndexLE。
 * 从 signal-stats.simulator.ts 迁移，逻辑不变。
 */

import { HoldingDaySnapshot, WindowQuote, HoldingDayExtras } from './types';

/**
 * 由「持有窗口日期序列 + quote/limit/exitHit 预取结果」组装 HoldingDaySnapshot[]。
 *
 * 与 simulator.db.ts 内联循环**语义等价**，唯一差异在 exitSignalHit 的判定：
 *   内联版：exitHitDates 来自 windowDates.slice(1) 的查询（buyDate 不在集合），故 days[0] 恒 false。
 *   本函数：hitSet 可能覆盖更大区间（含 buyDate），因此用 `idx > 0` 显式排除 days[0]，
 *   复刻原语义、保证 days[] byte-identical（zero-drift 核心不变量）。
 *
 * trailing_lock 新字段（qfqHigh/qfqLow/rawHigh/downLimit/ma5）：从 WindowQuote 可选字段 + extras 取；
 * fixed_n/strategy 路径不填这些 → 全 null，纯函数也不读，故现有两模式行为零漂移。
 *
 * @param windowDates  持有窗口的 SSE 交易日数组（buyDate 起升序）
 * @param quoteMap     预取的 quote 行（key=cal_date；停牌日无 key）
 * @param limitMap     预取的涨停价行（key=cal_date；缺失时 upLimit=null）
 * @param hitSet       命中卖出条件的交易日集合（可包含 buyDate，函数内部排除）
 * @param extras       可选附加数据（downLimitMap；trailing_lock 用）
 */
export function buildHoldingDays(
  windowDates: string[],
  quoteMap: Map<string, WindowQuote>,
  limitMap: Map<string, number | null>,
  hitSet: Set<string>,
  extras?: HoldingDayExtras,
): HoldingDaySnapshot[] {
  const downLimitMap = extras?.downLimitMap;
  return windowDates.map((calDate, idx) => {
    const q = quoteMap.get(calDate);
    const hasQuote = !!q && q.qfqOpen !== null && q.qfqClose !== null;
    return {
      calDate,
      hasQuote,
      qfqOpen: q?.qfqOpen ?? null,
      qfqClose: q?.qfqClose ?? null,
      qfqHigh: q?.qfqHigh ?? null,
      qfqLow: q?.qfqLow ?? null,
      rawOpen: q?.open ?? null,
      rawHigh: q?.high ?? null,
      upLimit: limitMap.get(calDate) ?? null,
      downLimit: downLimitMap?.get(calDate) ?? null,
      ma5: q?.ma5 ?? null,
      exitSignalHit: idx > 0 && hitSet.has(calDate),
    };
  });
}

/** 升序数组中 <= target 的最大元素下标（找不到返回 -1）。 */
export function findLastIndexLE(sortedAsc: string[], target: string): number {
  let lo = 0;
  let hi = sortedAsc.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
