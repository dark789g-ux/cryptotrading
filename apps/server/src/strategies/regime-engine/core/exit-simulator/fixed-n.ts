/**
 * exit-simulator/fixed-n.ts
 *
 * fixed_n 出场决策（init + step 循环包装，对外 API 不变）。
 */

import { HoldingDaySnapshot, ExitDecision } from './types';
import { initFixedNState, stepFixedN } from './steppers/fixed-n.step';

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
  if (days.length === 0) return null;
  let state = initFixedNState(days[0]);
  const opts = { horizonN, delistDate };
  for (let i = 1; i < days.length; i++) {
    const result = stepFixedN(state, days[i], opts);
    state = result.state;
    if (result.decision) return result.decision;
    if (result.done) return null;
  }
  return null;
}
