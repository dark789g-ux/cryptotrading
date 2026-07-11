/**
 * exit-simulator/strategy.ts
 *
 * strategy 出场决策（init + step 循环包装，对外 API 不变）。
 */

import { HoldingDaySnapshot, ExitDecision } from './types';
import { initStrategyState, stepStrategy } from './steppers/strategy.step';

/**
 * strategy 出场：buy_date 之后逐 SSE 交易日 d（从 days[1] 起，buy_date 当天不判）
 * 看 d 是否命中卖出条件（exitSignalHit）。
 *   首次命中 → qfq_close[d], 'signal'。
 *   满 max_hold 个**可交易持有日**仍未命中 → 第 max_hold 个可交易日 qfq_close 强平, 'max_hold'。
 *   退市优先：推进中先触发退市则退市强平。
 * 停牌日跳过（不判卖出、不占 max_hold 额度、不计 holdDays）。
 * 窗口耗尽（既未命中、又没凑满 max_hold、也没退市）→ null（insufficient_data）。
 */
export function decideStrategy(
  days: HoldingDaySnapshot[],
  maxHold: number,
  delistDate: string | null,
): ExitDecision | null {
  if (days.length === 0) return null;
  let state = initStrategyState(days[0]);
  const opts = { maxHold, delistDate };
  for (let i = 1; i < days.length; i++) {
    const result = stepStrategy(state, days[i], opts);
    state = result.state;
    if (result.decision) return result.decision;
    if (result.done) return null;
  }
  return null;
}
