import { mergeRankAudit } from './rank-audit-merge';
import { RegimeBacktestTrade } from './regime-backtest.types';
import { RankedCandidate } from './types/backtest-data.types';

describe('mergeRankAudit', () => {
  it('enriches top1 engine trade with rank=1', () => {
    const engine: RegimeBacktestTrade[] = [
      {
        signalDate: '20260101',
        buyDate: '20260102',
        exitDate: null,
        tsCode: '000001.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        status: 'taken',
        alloc: 100,
      },
    ];
    const ranked: RankedCandidate[] = [
      {
        signalDate: '20260101',
        buyDate: '20260102',
        tsCode: '000001.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        rank: 1,
        rankField: 'turnover_rate',
        rankValue: 12.3,
      },
      {
        signalDate: '20260101',
        buyDate: '20260102',
        tsCode: '000002.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        rank: 2,
        rankField: 'turnover_rate',
        rankValue: 11,
      },
    ];
    const { trades, extraSkipped } = mergeRankAudit(engine, ranked);
    expect(trades.filter((t) => t.rank === 1)).toHaveLength(1);
    expect(trades.find((t) => t.tsCode === '000001.SZ')?.rankValue).toBe(12.3);
    expect(trades.filter((t) => t.skipReason === 'not_top1')).toHaveLength(1);
    expect(extraSkipped).toBe(1);
  });

  it('does not duplicate rank=1 as not_top1', () => {
    const ranked: RankedCandidate[] = [
      {
        signalDate: '20260101',
        buyDate: '20260102',
        tsCode: '000002.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        rank: 2,
        rankField: 'turnover_rate',
        rankValue: 11,
      },
      {
        signalDate: '20260101',
        buyDate: '20260102',
        tsCode: '000003.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        rank: 3,
        rankField: 'turnover_rate',
        rankValue: 10,
      },
    ];
    const { trades } = mergeRankAudit([], ranked);
    expect(trades.every((t) => t.rank !== 1 || t.skipReason !== 'not_top1')).toBe(
      true,
    );
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.skipReason === 'not_top1')).toBe(true);
  });

  it('top1 already_held still rank=1 skipped, no promote rank2', () => {
    const engine: RegimeBacktestTrade[] = [
      {
        signalDate: '20260101',
        buyDate: '20260102',
        exitDate: null,
        tsCode: '000001.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        status: 'skipped',
        skipReason: 'already_held',
      },
    ];
    const ranked: RankedCandidate[] = [
      {
        signalDate: '20260101',
        buyDate: '20260102',
        tsCode: '000001.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        rank: 1,
        rankField: 'turnover_rate',
        rankValue: 12.3,
      },
      {
        signalDate: '20260101',
        buyDate: '20260102',
        tsCode: '000002.SZ',
        regime: 'Q1',
        exitMode: 'fixed_n',
        rank: 2,
        rankField: 'turnover_rate',
        rankValue: 11,
      },
    ];
    const { trades } = mergeRankAudit(engine, ranked);
    expect(trades.find((t) => t.rank === 1)?.skipReason).toBe('already_held');
    expect(trades.find((t) => t.rank === 2)?.skipReason).toBe('not_top1');
    expect(trades.filter((t) => t.status === 'taken')).toHaveLength(0);
  });
});
