/**
 * exit-simulator/steppers/strategy.step.ts
 *
 * strategy 增量 init / step。
 */

import { HoldingDaySnapshot, ExitDecision } from '../types';
import { StrategyPositionState, StrategyStepOpts, StepResult } from './types';

export function initStrategyState(entry: HoldingDaySnapshot): StrategyPositionState {
  return {
    mode: 'strategy',
    tradableCount: 0,
    lastQuoteDay: entry,
    lastQuoteTradable: 0,
  };
}

export function stepStrategy(
  state: StrategyPositionState,
  day: HoldingDaySnapshot,
  opts: StrategyStepOpts,
): StepResult<StrategyPositionState> {
  if (opts.delistDate !== null && day.calDate >= opts.delistDate) {
    if (state.lastQuoteDay.qfqClose === null) {
      return { state, decision: null, done: true };
    }
    const decision: ExitDecision = {
      exitDay: state.lastQuoteDay,
      exitReason: 'delist',
      holdDays: state.lastQuoteTradable,
    };
    return { state, decision };
  }

  if (!day.hasQuote) {
    return { state, decision: null };
  }

  const tradableCount = state.tradableCount + 1;
  const next: StrategyPositionState = {
    ...state,
    tradableCount,
    lastQuoteDay: day,
    lastQuoteTradable: tradableCount,
  };

  if (day.exitSignalHit) {
    return {
      state: next,
      decision: { exitDay: day, exitReason: 'signal', holdDays: tradableCount },
    };
  }

  if (tradableCount === opts.maxHold) {
    return {
      state: next,
      decision: { exitDay: day, exitReason: 'max_hold', holdDays: tradableCount },
    };
  }

  return { state: next, decision: null };
}
