/**
 * exit-simulator/fixed-n.ts
 *
 * fixed_n 出场决策。
 * 从 signal-stats.simulator.ts 迁移，逻辑不变。
 */

import { HoldingDaySnapshot, ExitDecision } from './types';

/**
 * fixed_n 出场：持有到 buy_date 后第 N 个**实际可交易日**（停牌日跳过、不计额度），
 * exit_price = 该日 qfq_close, exit_reason='max_hold'。
 *
 * 计数：days[0]=buy_date 是第 0 个可交易日（已确认有 quote）；从 days[1] 起遇可交易日 +1，
 * 数到第 N 个即出场。holdDays = 已走过可交易日数（= tradableCount），fixed_n 恒 == N。
 *
 * 退市优先：推进中先触发退市则按退市强平。
 * 窗口耗尽仍未凑满 N → null（insufficient_data）。
 */
export function decideFixedN(
  days: HoldingDaySnapshot[],
  horizonN: number,
  delistDate: string | null,
): ExitDecision | null {
  let tradableCount = 0;
  let lastQuoteIdx = 0;
  let lastQuoteTradable = 0;
  for (let i = 1; i < days.length; i++) {
    if (delistDate !== null && days[i].calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) return null;
      return {
        exitDay: days[lastQuoteIdx],
        exitReason: 'delist',
        holdDays: lastQuoteTradable,
      };
    }
    if (!days[i].hasQuote) continue;
    tradableCount++;
    lastQuoteIdx = i;
    lastQuoteTradable = tradableCount;
    if (tradableCount === horizonN) {
      return { exitDay: days[i], exitReason: 'max_hold', holdDays: tradableCount };
    }
  }
  return null;
}
