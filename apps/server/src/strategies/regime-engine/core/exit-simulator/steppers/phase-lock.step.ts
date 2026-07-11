/**
 * exit-simulator/steppers/phase-lock.step.ts
 *
 * phase_lock 增量 init / step。
 * 循环体从 decidePhaseLock 抽出；decidePhaseLock 将 StepDecision 映射为 PhaseLockOutcome。
 */

import { HoldingDaySnapshot, PhaseLockOptions } from '../types';
import { floor2 } from '../floor2';
import {
  PhaseLockPositionState,
  PhaseLockStepOpts,
  PhaseLockStepDecision,
  InitPhaseLockResult,
  StepResult,
} from './types';

function isDeadLimitDown(day: HoldingDaySnapshot): boolean {
  if (day.downLimit === null || day.rawHigh === null) return false;
  return day.rawHigh <= day.downLimit;
}

export function initPhaseLockState(
  entry: HoldingDaySnapshot,
  recentLows: number[],
  opts: Pick<PhaseLockOptions, 'initFactor'>,
): InitPhaseLockResult {
  if (!entry.hasQuote || entry.qfqOpen === null) {
    return { kind: 'no_entry', reason: 'suspended' };
  }
  if (entry.upLimit !== null && entry.rawOpen !== null && entry.rawOpen >= entry.upLimit) {
    return { kind: 'no_entry', reason: 'limit_up' };
  }

  const cost = entry.qfqOpen;
  const initStop: number | null =
    recentLows.length === 0 ? null : floor2(Math.min(...recentLows) * opts.initFactor);

  return {
    kind: 'ok',
    state: {
      mode: 'phase_lock',
      cost,
      stopNext: initStop,
      locked: false,
      pending: null,
      hold: 0,
      prevMa5: entry.ma5,
      lastQuoteDay: entry,
      lastQuoteHold: 0,
    },
  };
}

export function stepPhaseLock(
  state: PhaseLockPositionState,
  day: HoldingDaySnapshot,
  opts: PhaseLockStepOpts,
): StepResult<PhaseLockPositionState, PhaseLockStepDecision> {
  const { lockFactor, delistDate } = opts;

  if (delistDate !== null && day.calDate >= delistDate) {
    if (state.lastQuoteDay.qfqClose === null) {
      return { state, decision: null, done: true };
    }
    return {
      state,
      decision: {
        reason: 'delist',
        exitDay: state.lastQuoteDay,
        exitPrice: null,
        holdDays: state.lastQuoteHold,
        locked: state.locked,
      },
    };
  }

  if (!day.hasQuote) {
    return { state, decision: null };
  }

  let { stopNext, locked, pending, hold, prevMa5 } = state;
  const { cost } = state;

  hold += 1;
  const lastQuoteDay = day;
  const lastQuoteHold = hold;
  const stopEff = stopNext;
  const deadLimitDown = isDeadLimitDown(day);

  // (0) 顺延中
  if (pending !== null) {
    if (!deadLimitDown) {
      const next: PhaseLockPositionState = {
        ...state,
        stopNext,
        locked,
        pending,
        hold,
        prevMa5,
        lastQuoteDay,
        lastQuoteHold,
      };
      return {
        state: next,
        decision: {
          reason: pending,
          exitDay: day,
          exitPrice: day.qfqOpen,
          holdDays: hold,
          locked,
        },
      };
    }
    const next: PhaseLockPositionState = {
      ...state,
      hold,
      lastQuoteDay,
      lastQuoteHold,
    };
    return { state: next, decision: null };
  }

  // (1) 盘中止损
  if (stopEff !== null && day.qfqLow !== null && day.qfqLow <= stopEff) {
    if (deadLimitDown) {
      const next: PhaseLockPositionState = {
        ...state,
        pending: 'phase_lock_stop',
        hold,
        lastQuoteDay,
        lastQuoteHold,
      };
      return { state: next, decision: null };
    }
    const fill = day.qfqOpen !== null ? Math.min(stopEff, day.qfqOpen) : stopEff;
    const next: PhaseLockPositionState = {
      ...state,
      hold,
      lastQuoteDay,
      lastQuoteHold,
    };
    return {
      state: next,
      decision: {
        reason: 'phase_lock_stop',
        exitDay: day,
        exitPrice: fill,
        holdDays: hold,
        locked,
      },
    };
  }

  // (2) 收盘判断
  if (!locked) {
    if (
      day.ma5 !== null &&
      prevMa5 !== null &&
      day.qfqClose !== null &&
      day.qfqClose > day.ma5 &&
      day.ma5 > prevMa5
    ) {
      const base = day.qfqLow !== null ? Math.max(cost, day.qfqLow) : cost;
      stopNext = floor2(base * lockFactor);
      locked = true;
    }
  } else {
    if (
      day.ma5 !== null &&
      day.qfqClose !== null &&
      day.qfqClose < day.ma5 &&
      prevMa5 !== null &&
      day.ma5 < prevMa5
    ) {
      if (deadLimitDown) {
        const next: PhaseLockPositionState = {
          ...state,
          stopNext,
          locked,
          pending: 'phase_lock_ma5',
          hold,
          prevMa5: day.ma5,
          lastQuoteDay,
          lastQuoteHold,
        };
        return { state: next, decision: null };
      }
      const next: PhaseLockPositionState = {
        ...state,
        stopNext,
        locked,
        pending,
        hold,
        prevMa5,
        lastQuoteDay,
        lastQuoteHold,
      };
      return {
        state: next,
        decision: {
          reason: 'phase_lock_ma5',
          exitDay: day,
          exitPrice: day.qfqClose,
          holdDays: hold,
          locked,
        },
      };
    }
  }

  const next: PhaseLockPositionState = {
    ...state,
    stopNext,
    locked,
    pending,
    hold,
    prevMa5: day.ma5,
    lastQuoteDay,
    lastQuoteHold,
  };
  return { state: next, decision: null };
}
