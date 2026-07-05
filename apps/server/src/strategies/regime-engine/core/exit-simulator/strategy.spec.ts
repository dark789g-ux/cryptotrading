import { decideStrategy } from './strategy';
import { tradingDay } from './__tests__/fixtures';

describe('decideStrategy', () => {
  it('首次命中优先于 max_hold', () => {
    const days = [
      tradingDay('d0'),
      tradingDay('d1', { exitSignalHit: true, qfqClose: 7 }),
      tradingDay('d2'),
    ];
    const d = decideStrategy(days, 5, null);
    expect(d!.exitDay.calDate).toBe('d1');
    expect(d!.exitReason).toBe('signal');
  });

  it('未命中走 max_hold', () => {
    const days = [tradingDay('d0'), tradingDay('d1', { qfqClose: 6 })];
    const d = decideStrategy(days, 1, null);
    expect(d!.exitDay.calDate).toBe('d1');
    expect(d!.exitReason).toBe('max_hold');
  });
});
