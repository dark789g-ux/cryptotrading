import { RegimeBacktestTradeEntity } from '../../../entities/strategy/regime-backtest-trade.entity';
import {
  aggregateSymbolStats,
  normalizeTradeDateLabel,
  overlayTradesOnBars,
  paginatePositions,
  paginateSymbolStats,
  tradeEntityToPosition,
  type RegimeTradeOnBar,
} from './regime-backtest-audit.helpers';

function makeTrade(partial: Partial<RegimeBacktestTradeEntity>): RegimeBacktestTradeEntity {
  return {
    id: 't1',
    runId: 'run-1',
    signalDate: '20260101',
    buyDate: '20260102',
    exitDate: '20260105',
    tsCode: '000001.SZ',
    regime: 'bull',
    exitMode: 'fixed_n',
    status: 'taken',
    skipReason: null,
    tradePhase: 'live',
    exitReason: 'fixed_n',
    ret: '0.05',
    alloc: '100000',
    costsPaid: '50',
    realizedRetNet: '0.04',
    rank: 1,
    rankField: 'turnover_rate',
    rankValue: '1.2',
    ...partial,
  } as RegimeBacktestTradeEntity;
}

describe('regime-backtest-audit.helpers', () => {
  it('normalizeTradeDateLabel converts YYYYMMDD to YYYY-MM-DD', () => {
    expect(normalizeTradeDateLabel('20260102')).toBe('2026-01-02');
    expect(normalizeTradeDateLabel('2026-01-02')).toBe('2026-01-02');
  });

  it('aggregateSymbolStats groups taken trades by tsCode', () => {
    const rows = aggregateSymbolStats([
      makeTrade({ tsCode: '000001.SZ', realizedRetNet: '0.04', alloc: '100000' }),
      makeTrade({ id: 't2', tsCode: '000001.SZ', realizedRetNet: '-0.02', alloc: '80000' }),
      makeTrade({ id: 't3', tsCode: '000002.SZ', realizedRetNet: '0.1', alloc: '50000' }),
    ]);
    const a = rows.find((r) => r.tsCode === '000001.SZ');
    expect(a?.tradeCount).toBe(2);
    expect(a?.winCount).toBe(1);
    expect(a?.lossCount).toBe(1);
    expect(a?.totalAlloc).toBe(180000);
  });

  it('overlayTradesOnBars attaches entry/exit markers', () => {
    const bars: Array<{ open_time: string; close: number; trades?: RegimeTradeOnBar[] }> = [
      { open_time: '2026-01-02', close: 10 },
      { open_time: '2026-01-05', close: 11 },
    ];
    overlayTradesOnBars(bars, [makeTrade({})], '000001.SZ');
    expect(bars[0].trades?.[0].type).toBe('entry');
    expect(bars[1].trades?.[0].type).toBe('exit');
  });

  it('paginatePositions filters and sorts', () => {
    const rows = [
      tradeEntityToPosition(makeTrade({ tsCode: '000002.SZ', signalDate: '20260103' })),
      tradeEntityToPosition(makeTrade({ tsCode: '000001.SZ', signalDate: '20260101' })),
    ];
    const page = paginatePositions(rows, { page: 1, pageSize: 10, sortBy: 'signalDate', sortOrder: 'asc' });
    expect(page.total).toBe(2);
    expect(page.items[0].tsCode).toBe('000001.SZ');
  });

  it('paginateSymbolStats sorts by totalPnl desc by default key', () => {
    const rows = aggregateSymbolStats([
      makeTrade({ tsCode: '000001.SZ', realizedRetNet: '0.01', alloc: '10000' }),
      makeTrade({ id: 't2', tsCode: '000002.SZ', realizedRetNet: '0.1', alloc: '10000' }),
    ]);
    const page = paginateSymbolStats(rows, { page: 1, pageSize: 10, sortBy: 'totalPnl', sortOrder: 'desc' });
    expect(page.items[0].tsCode).toBe('000002.SZ');
  });
});
