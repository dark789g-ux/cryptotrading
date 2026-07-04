import { computeSummary, EngineDailyRow } from './summary';

describe('core/summary', () => {
  function row(overrides: Partial<EngineDailyRow> = {}): EngineDailyRow {
    return {
      tradeDate: '20260101',
      nav: 1_000_000,
      cash: 1_000_000,
      dailyRet: 0,
      positionCount: 0,
      exposure: 0,
      ...overrides,
    };
  }

  it('empty dailyRows → identity summary', () => {
    const s = computeSummary([], 0, 0, 1_000_000, 0);
    expect(s.finalNav).toBe(1_000_000);
    expect(s.totalRet).toBe(0);
    expect(s.annualRet).toBeNull();
    expect(s.maxDrawdown).toBe(0);
    expect(s.sharpe).toBeNull();
    expect(s.calmar).toBeNull();
    expect(s.nTaken).toBe(0);
    expect(s.nSkipped).toBe(0);
    expect(s.totalCosts).toBe(0);
  });

    it('normal run: positive returns, sharpe/calmar/drawdown', () => {
      const rows = [
        row({ tradeDate: '20260101', nav: 1_000_000, dailyRet: 0 }),
        row({ tradeDate: '20260102', nav: 1_010_000, dailyRet: 0.01 }),
        row({ tradeDate: '20260103', nav: 1_020_000, dailyRet: 1_020_000 / 1_010_000 - 1 }),
        row({ tradeDate: '20260104', nav: 990_000, dailyRet: 990_000 / 1_020_000 - 1 }),
      ];
      const s = computeSummary(rows, 5, 2, 1_000_000, 100);
      expect(s.finalNav).toBe(990_000);
      expect(s.totalRet).toBeCloseTo(-0.01, 5);
      expect(s.annualRet).not.toBeNull();
      expect(s.maxDrawdown).toBeLessThan(0);
      expect(s.nTaken).toBe(5);
      expect(s.nSkipped).toBe(2);
      expect(s.totalCosts).toBe(100);
    });

  it('all losses: negative totalRet, drawdown', () => {
    const rows = [
      row({ tradeDate: '20260101', nav: 1_000_000, dailyRet: 0 }),
      row({ tradeDate: '20260102', nav: 900_000, dailyRet: -0.1 }),
      row({ tradeDate: '20260103', nav: 800_000, dailyRet: 800_000 / 900_000 - 1 }),
    ];
    const s = computeSummary(rows, 3, 0, 1_000_000, 0);
    expect(s.finalNav).toBe(800_000);
      expect(s.totalRet).toBeCloseTo(-0.2, 10);
    expect(s.maxDrawdown).toBeCloseTo(-0.2, 5);
    expect(s.calmar).not.toBeNull();
  });

  it('single day: annualRet computed (finalNav>0)', () => {
    const rows = [
      row({ tradeDate: '20260101', nav: 1_100_000, dailyRet: 0.1 }),
    ];
    const s = computeSummary(rows, 1, 0, 1_000_000, 0);
    expect(s.finalNav).toBe(1_100_000);
    expect(s.annualRet).not.toBeNull();
    expect(s.sharpe).toBeNull();
  });
});
