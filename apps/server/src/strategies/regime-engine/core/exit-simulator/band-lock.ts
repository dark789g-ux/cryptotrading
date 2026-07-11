/**
 * exit-simulator/band-lock.ts
 *
 * 波段跟踪止损 trailing_lock：floor2 / decideBandLock。
 * decideBandLock = initBandLockState + stepBandLock 循环（对外 API 不变）。
 */

import { HoldingDaySnapshot, ExitDecision, BandLockOptions } from './types';
import { initBandLockState, stepBandLock } from './steppers/band-lock.step';

export { floor2 } from './floor2';

/**
 * trailing_lock 出场：波段跟踪止损 + 锁定 + 锁定后 MA5 收盘离场 + 封死跌停顺延（同构 Python 共享核）。
 *
 * 与 Python `simulate_band_lock` 逐行对应（规范见 01-rule-semantics.md §三）：
 * - 入场端（停牌 / 一字涨停 / 次新）由 simulateTradeCore 先行过滤，本函数只接管 buyPrice 之后的出场推进。
 * - days[0] = buy_date(T+1)；从 days[1] 起逐日推进；停牌日（hasQuote=false）跳过（不计 hold/不触发/不更新/不动 prev_ma5）。
 * - 止损成交价（stop）≠ qfq_close（跳空低开取 open，故 min(stop_eff, open)），由返回的 exitPrice 显式给出。
 * - 核函数不处理退市：signal-stats 在此**额外**接 delistDate 分支（沿用 decideFixedN/decideStrategy 口径，
 *   reason='delist'、用退市前最后一个有 quote 日 qfq_close 强平），与现有两模式一致。
 * - 窗口耗尽未出场（含顺延未解）→ null（insufficient_data），与现有口径一致。
 */
export function decideBandLock(
  days: HoldingDaySnapshot[],
  opts: BandLockOptions,
): ExitDecision | null {
  if (days.length === 0) return null;
  let state = initBandLockState(days[0], opts);
  for (let i = 1; i < days.length; i++) {
    const result = stepBandLock(state, days[i], opts);
    state = result.state;
    if (result.decision) return result.decision;
    if (result.done) return null;
  }
  return null;
}
