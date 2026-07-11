/**
 * exit-simulator/steppers/band-lock.step.ts
 *
 * trailing_lock（band-lock）增量 init / step。
 * 循环体从 decideBandLock 抽出，语义不变。
 */

import { HoldingDaySnapshot, ExitDecision, BandLockOptions } from '../types';
import { floor2 } from '../floor2';
import { BandLockPositionState, BandLockStepOpts, StepResult } from './types';

function isDeadLimitDown(day: HoldingDaySnapshot): boolean {
  if (day.downLimit === null || day.rawHigh === null) return false;
  return day.rawHigh <= day.downLimit;
}

export function initBandLockState(
  entry: HoldingDaySnapshot,
  opts: Pick<BandLockOptions, 'stopRatio' | 'floorRatio'>,
): BandLockPositionState {
  const stopRatio = opts.stopRatio ?? 0.999;
  const floorRatio = opts.floorRatio ?? 0.999;

  const cost = entry.qfqOpen!;
  const scheme: 1 | 2 =
    entry.qfqClose !== null && entry.qfqClose > entry.qfqOpen! ? 1 : 2;

  let stopNext: number | null;
  if (scheme === 1) {
    stopNext = floor2(entry.qfqOpen! * stopRatio);
  } else {
    const baseLow = entry.qfqLow !== null ? entry.qfqLow : entry.qfqOpen!;
    stopNext = floor2(baseLow * stopRatio);
  }

  return {
    mode: 'trailing_lock',
    scheme,
    cost,
    stopNext,
    locked: false,
    floorActive: false,
    pending: null,
    hold: 0,
    prevMa5: entry.ma5,
    floorPrice: floor2(cost * floorRatio),
    lastQuoteDay: entry,
    lastQuoteHold: 0,
  };
}

export function stepBandLock(
  state: BandLockPositionState,
  day: HoldingDaySnapshot,
  opts: BandLockStepOpts,
): StepResult<BandLockPositionState> {
  const { signalHigh, maxHold, delistDate } = opts;
  const stopRatio = opts.stopRatio ?? 0.999;
  const floorEnabled = opts.floorEnabled ?? true;
  const ma5RequireDown = opts.ma5RequireDown ?? true;

  if (delistDate !== null && day.calDate >= delistDate) {
    if (state.lastQuoteDay.qfqClose === null) {
      return { state, decision: null, done: true };
    }
    const decision: ExitDecision = {
      exitDay: state.lastQuoteDay,
      exitReason: 'delist',
      holdDays: state.lastQuoteHold,
    };
    return { state, decision };
  }

  if (!day.hasQuote) {
    return { state, decision: null };
  }

  let {
    stopNext,
    locked,
    floorActive,
    pending,
    hold,
    prevMa5,
  } = state;
  const { scheme, cost, floorPrice } = state;

  hold += 1;
  const lastQuoteDay = day;
  const lastQuoteHold = hold;
  const stopEff = stopNext;
  const deadLimitDown = isDeadLimitDown(day);

  // (0) 顺延中（pending ≠ null）
  if (pending !== null) {
    if (!deadLimitDown) {
      const next: BandLockPositionState = {
        ...state,
        stopNext,
        locked,
        floorActive,
        pending,
        hold,
        prevMa5,
        lastQuoteDay,
        lastQuoteHold,
      };
      return {
        state: next,
        decision: {
          exitDay: day,
          exitReason: pending,
          exitPrice: day.qfqOpen ?? undefined,
          holdDays: hold,
        },
      };
    }
    const next: BandLockPositionState = {
      ...state,
      hold,
      lastQuoteDay,
      lastQuoteHold,
    };
    return { state: next, decision: null };
  }

  // (1) 日内止损
  if (stopEff !== null && day.qfqLow !== null && day.qfqLow <= stopEff) {
    if (deadLimitDown) {
      const next: BandLockPositionState = {
        ...state,
        pending: 'stop',
        hold,
        lastQuoteDay,
        lastQuoteHold,
      };
      return { state: next, decision: null };
    }
    const fill = day.qfqOpen !== null ? Math.min(stopEff, day.qfqOpen) : stopEff;
    const next: BandLockPositionState = {
      ...state,
      hold,
      lastQuoteDay,
      lastQuoteHold,
    };
    return {
      state: next,
      decision: { exitDay: day, exitReason: 'stop', exitPrice: fill, holdDays: hold },
    };
  }

  // (2) 收盘处理（未被止损）
  // (2-pre) 方案二保本地板激活
  if (floorEnabled && scheme === 2 && day.qfqClose !== null && day.qfqClose > cost) {
    floorActive = true;
  }

  // (2a) 未锁定 且 qfq_low > signalHigh → 锁定
  if (!locked && day.qfqLow !== null && day.qfqLow > signalHigh) {
    stopNext = floor2(day.qfqLow * stopRatio);
    if (floorEnabled && scheme === 2 && floorActive) {
      stopNext = Math.max(stopNext, floorPrice);
    }
    locked = true;
  }

  if (locked) {
    // (2b) 已锁定 → MA5 收盘离场
    let ma5ExitHit =
      day.ma5 !== null && day.qfqClose !== null && day.qfqClose < day.ma5;
    if (ma5RequireDown) {
      ma5ExitHit = ma5ExitHit && prevMa5 !== null && day.ma5! < prevMa5;
    }
    if (ma5ExitHit) {
      if (deadLimitDown) {
        const next: BandLockPositionState = {
          ...state,
          stopNext,
          locked,
          floorActive,
          pending: 'ma5_exit',
          hold,
          prevMa5: day.ma5,
          lastQuoteDay,
          lastQuoteHold,
        };
        return { state: next, decision: null };
      }
      const next: BandLockPositionState = {
        ...state,
        stopNext,
        locked,
        floorActive,
        pending,
        hold,
        prevMa5,
        lastQuoteDay,
        lastQuoteHold,
      };
      return {
        state: next,
        decision: {
          exitDay: day,
          exitReason: 'ma5_exit',
          exitPrice: day.qfqClose!,
          holdDays: hold,
        },
      };
    }
  } else {
    // (2c) 未锁定 → 更新次日止损 stopNext
    if (day.qfqLow !== null) {
      const lowStop = floor2(day.qfqLow * stopRatio);
      if (floorEnabled && scheme === 2 && floorActive) {
        stopNext = Math.max(lowStop, floorPrice);
      } else {
        stopNext = lowStop;
      }
    }
  }

  // (2d) max_hold 兜底
  if (maxHold !== undefined && hold >= maxHold) {
    const next: BandLockPositionState = {
      ...state,
      stopNext,
      locked,
      floorActive,
      pending,
      hold,
      prevMa5,
      lastQuoteDay,
      lastQuoteHold,
    };
    return {
      state: next,
      decision: {
        exitDay: day,
        exitReason: 'max_hold',
        exitPrice: day.qfqClose ?? undefined,
        holdDays: hold,
      },
    };
  }

  const next: BandLockPositionState = {
    ...state,
    stopNext,
    locked,
    floorActive,
    pending,
    hold,
    prevMa5: day.ma5,
    lastQuoteDay,
    lastQuoteHold,
  };
  return { state: next, decision: null };
}
