import { decideFixedN } from './fixed-n';
import { tradingDay } from './__tests__/fixtures';

describe('decideFixedN', () => {
  it('正常 N=2', () => {
    const days = [tradingDay('d0'), tradingDay('d1'), tradingDay('d2', { qfqClose: 5 })];
    const d = decideFixedN(days, 2, null);
    expect(d).not.toBeNull();
    expect(d!.exitDay.calDate).toBe('d2');
    expect(d!.exitReason).toBe('max_hold');
    expect(d!.holdDays).toBe(2);
  });

  it('窗口不足 → null', () => {
    const days = [tradingDay('d0')];
    expect(decideFixedN(days, 1, null)).toBeNull();
  });
});
