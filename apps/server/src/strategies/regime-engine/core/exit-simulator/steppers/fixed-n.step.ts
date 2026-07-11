/**
 * exit-simulator/steppers/fixed-n.step.ts
 *
 * fixed_n 增量 init / step。
 */

import { HoldingDaySnapshot, ExitDecision } from '../types';
import { FixedNPositionState, FixedNStepOpts, StepResult } from './types';

export function initFixedNState(entry: HoldingDaySnapshot): FixedNPositionState {
  return {
    mode: 'fixed_n',
    tradableCount: 0,
    lastQuoteDay: entry,
    lastQuoteTradable: 0,
  };
}

export function stepFixedN(
  state: FixedNPositionState,
  day: HoldingDaySnapshot,
  opts: FixedNStepOpts,
): StepResult<FixedNPositionState> {
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
  const next: FixedNPositionState = {
    ...state,
    tradableCount,
    lastQuoteDay: day,
    lastQuoteTradable: tradableCount,
  };

  if (tradableCount === opts.horizonN) {
    return {
      state: next,
      decision: { exitDay: day, exitReason: 'max_hold', holdDays: tradableCount },
    };
  }

  return { state: next, decision: null };
}
