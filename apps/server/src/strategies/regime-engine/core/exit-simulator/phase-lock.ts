/**
 * exit-simulator/phase-lock.ts
 *
 * 阶段锁定 phase_lock 出场决策（init + step 循环包装，对外 API 不变）。
 */

import { HoldingDaySnapshot, PhaseLockOptions, PhaseLockOutcome } from './types';
import { initPhaseLockState, stepPhaseLock } from './steppers/phase-lock.step';

/**
 * phase_lock 出场：两阶段锁定止损（初始止损固定 → 收盘站上 MA5↑ 锁定上移 → 阶段 B 收盘破 MA5↓ 清仓 + 跌停顺延）。
 *
 * 与 Python `simulate_phase_lock` **逐行对应**（规范见 01-algorithm.md），数值权威源为
 * test_phase_lock_exit.py（S1~S15）。返回 PhaseLockOutcome（与 Python 同构，含 no_entry/no_exit 的
 * locked/holdDays），由 simulateTradeCore 翻译为 ExitDecision/filtered。映射约定：
 *   adj_open→qfqOpen, adj_high→qfqHigh, adj_low→qfqLow, adj_close→qfqClose, ma5→ma5,
 *   raw_open→rawOpen, raw_high→rawHigh, up_limit→upLimit, down_limit→downLimit；
 *   停牌（_is_suspended）→ hasQuote=false（与 buildHoldingDays 口径一致）。
 *
 * - days[0] = buy_date(T+1)；从 days[1] 起逐日推进；停牌日（hasQuote=false）跳过。
 * - 与 band_lock 核心差异：阶段 A 初始止损**固定不上移**（band_lock 逐日用当日 low 抬升）。
 * - 止损成交价（stop）≠ qfq_close（跳空低开取 open，故 min(stop_eff, open)），由 exitPrice 显式给出。
 * - recentLows 由数据层切好（含 T+1 的最近 lookback 个非停牌复权 low，升序）；空 → 无初始止损。
 * - 核函数不处理退市：signal-stats 在此**额外**接 delistDate 分支（沿用 decideBandLock 口径，
 *   reason='delist'、用退市前最后一个有 quote 日 qfq_close 强平）。
 * - 入场端（停牌 / 一字涨停）也复刻 Python 的 no_entry（便于 spec 逐数值对拍）；
 *   生产路径上 simulateTradeCore 已前置过滤，no_entry 仅作冗余防御。
 */
export function decidePhaseLock(
  days: HoldingDaySnapshot[],
  recentLows: number[],
  opts: PhaseLockOptions,
): PhaseLockOutcome {
  if (days.length === 0) {
    return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }

  const init = initPhaseLockState(days[0], recentLows, opts);
  if (init.kind === 'no_entry') {
    return {
      kind: 'no_entry',
      reason: init.reason,
      exitIndex: null,
      exitPrice: null,
      holdDays: 0,
      locked: false,
    };
  }

  let state = init.state;
  for (let i = 1; i < days.length; i++) {
    const result = stepPhaseLock(state, days[i], opts);
    state = result.state;
    if (result.decision) {
      const d = result.decision;
      return {
        kind: 'exit',
        reason: d.reason,
        exitIndex: days.indexOf(d.exitDay),
        exitPrice: d.exitPrice,
        holdDays: d.holdDays,
        locked: d.locked,
      };
    }
    if (result.done) {
      return {
        kind: 'no_exit',
        reason: null,
        exitIndex: null,
        exitPrice: null,
        holdDays: state.hold,
        locked: state.locked,
      };
    }
  }

  return {
    kind: 'no_exit',
    reason: null,
    exitIndex: null,
    exitPrice: null,
    holdDays: state.hold,
    locked: state.locked,
  };
}
