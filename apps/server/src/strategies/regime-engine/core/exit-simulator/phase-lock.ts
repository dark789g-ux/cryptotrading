/**
 * exit-simulator/phase-lock.ts
 *
 * 阶段锁定 phase_lock 出场决策。
 * 从 signal-stats.simulator.ts 迁移，逻辑不变。
 */

import { HoldingDaySnapshot, PhaseLockOptions, PhaseLockOutcome } from './types';
import { floor2 } from './band-lock';

function isDeadLimitDown(day: HoldingDaySnapshot): boolean {
  if (day.downLimit === null || day.rawHigh === null) return false;
  return day.rawHigh <= day.downLimit;
}

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
  const { initFactor, lockFactor, delistDate } = opts;
  if (days.length === 0) {
    return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }

  const entry = days[0];

  if (!entry.hasQuote || entry.qfqOpen === null) {
    return { kind: 'no_entry', reason: 'suspended', exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }
  if (entry.upLimit !== null && entry.rawOpen !== null && entry.rawOpen >= entry.upLimit) {
    return { kind: 'no_entry', reason: 'limit_up', exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }

  const cost = entry.qfqOpen;

  const initStop: number | null =
    recentLows.length === 0 ? null : floor2(Math.min(...recentLows) * initFactor);

  let stopNext: number | null = initStop;
  let locked = false;
  let pending: 'phase_lock_stop' | 'phase_lock_ma5' | null = null;
  let hold = 0;
  let prevMa5 = entry.ma5;

  let lastQuoteIdx = 0;
  let lastQuoteHold = 0;

  for (let i = 1; i < days.length; i++) {
    const bar = days[i];

    if (delistDate !== null && bar.calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) {
        return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: hold, locked };
      }
      return {
        kind: 'exit',
        reason: 'delist',
        exitIndex: lastQuoteIdx,
        exitPrice: null,
        holdDays: lastQuoteHold,
        locked,
      };
    }

    if (!bar.hasQuote) continue;

    hold += 1;
    lastQuoteIdx = i;
    lastQuoteHold = hold;
    const stopEff = stopNext;
    const deadLimitDown = isDeadLimitDown(bar);

    // (0) 顺延中（上日封死跌停未能出场）
    if (pending !== null) {
      if (!deadLimitDown) {
        return {
          kind: 'exit',
          reason: pending,
          exitIndex: i,
          exitPrice: bar.qfqOpen,
          holdDays: hold,
          locked,
        };
      }
      continue;
    }

    // (1) 盘中止损 [最高优先]
    if (stopEff !== null && bar.qfqLow !== null && bar.qfqLow <= stopEff) {
      if (deadLimitDown) {
        pending = 'phase_lock_stop';
        continue;
      }
      const fill = bar.qfqOpen !== null ? Math.min(stopEff, bar.qfqOpen) : stopEff;
      return {
        kind: 'exit',
        reason: 'phase_lock_stop',
        exitIndex: i,
        exitPrice: fill,
        holdDays: hold,
        locked,
      };
    }

    // (2) 收盘判断（当日未触止损）
    if (!locked) {
      if (
        bar.ma5 !== null &&
        prevMa5 !== null &&
        bar.qfqClose !== null &&
        bar.qfqClose > bar.ma5 &&
        bar.ma5 > prevMa5
      ) {
        const base = bar.qfqLow !== null ? Math.max(cost, bar.qfqLow) : cost;
        stopNext = floor2(base * lockFactor);
        locked = true;
      }
    } else {
      if (
        bar.ma5 !== null &&
        bar.qfqClose !== null &&
        bar.qfqClose < bar.ma5 &&
        prevMa5 !== null &&
        bar.ma5 < prevMa5
      ) {
        if (deadLimitDown) {
          pending = 'phase_lock_ma5';
          prevMa5 = bar.ma5;
          continue;
        }
        return {
          kind: 'exit',
          reason: 'phase_lock_ma5',
          exitIndex: i,
          exitPrice: bar.qfqClose,
          holdDays: hold,
          locked,
        };
      }
    }

    prevMa5 = bar.ma5;
  }

  return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: hold, locked };
}
