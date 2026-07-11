/**
 * exit-simulator/steppers/band-lock.step.spec.ts
 *
 * trailing_lock 步进器最小覆盖：止损 / max_hold / 停牌跳过。
 */

import { tradingDay, suspendedDay } from '../__tests__/fixtures';
import { initBandLockState, stepBandLock } from './band-lock.step';
import { floor2 } from '../floor2';

describe('stepBandLock', () => {
  const baseOpts = {
    signalHigh: 100,
    delistDate: null as string | null,
    stopRatio: 0.999,
  };

  it('stop exit：方案一触止损', () => {
    const entry = tradingDay('d0', { qfqOpen: 10, qfqClose: 11, qfqLow: 9.8 });
    const state = initBandLockState(entry, baseOpts);
    expect(state.scheme).toBe(1);
    expect(state.stopNext).toBe(floor2(10 * 0.999));

    const day1 = tradingDay('d1', {
      qfqOpen: 10,
      qfqClose: 9.5,
      qfqLow: 9.5,
    });
    const result = stepBandLock(state, day1, { ...baseOpts, signalHigh: 100 });
    expect(result.decision).not.toBeNull();
    expect(result.decision!.exitReason).toBe('stop');
    expect(result.decision!.holdDays).toBe(1);
    expect(result.decision!.exitPrice).toBe(Math.min(state.stopNext!, 10));
  });

  it('max_hold：未触止损满持有日强平', () => {
    const entry = tradingDay('d0', { qfqOpen: 10, qfqClose: 11 });
    const state = initBandLockState(entry, baseOpts);
    const day1 = tradingDay('d1', {
      qfqOpen: 10.5,
      qfqClose: 10.5,
      qfqLow: 10.2,
      ma5: 10,
    });
    const result = stepBandLock(state, day1, {
      ...baseOpts,
      signalHigh: 100,
      maxHold: 1,
    });
    expect(result.decision).not.toBeNull();
    expect(result.decision!.exitReason).toBe('max_hold');
    expect(result.decision!.holdDays).toBe(1);
    expect(result.decision!.exitPrice).toBe(10.5);
  });

  it('suspended skip：hasQuote=false 不计 hold、不触发', () => {
    const entry = tradingDay('d0', { qfqOpen: 10, qfqClose: 11 });
    const state = initBandLockState(entry, baseOpts);
    const sus = suspendedDay('d1');
    const result = stepBandLock(state, sus, { ...baseOpts, signalHigh: 100, maxHold: 1 });
    expect(result.decision).toBeNull();
    expect(result.state.hold).toBe(0);
    expect(result.state.stopNext).toBe(state.stopNext);
    expect(result.state.lastQuoteDay.calDate).toBe('d0');
  });
});
