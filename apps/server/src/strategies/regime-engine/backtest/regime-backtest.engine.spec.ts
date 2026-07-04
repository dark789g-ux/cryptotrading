import { runRegimeBacktest } from './regime-backtest.engine';
import {
  RegimeBacktestInput,
} from './regime-backtest.types';
import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { COST_PRESET_ZERO } from '../core/cost';
import {
  HoldingDaySnapshot,
  SimulationInput,
} from '../core/exit-simulator';

function holdingDay(overrides: Partial<HoldingDaySnapshot> = {}): HoldingDaySnapshot {
  return {
    calDate: '20260102',
    hasQuote: true,
    qfqOpen: 10,
    qfqClose: 10,
    qfqHigh: null,
    qfqLow: null,
    rawOpen: null,
    rawHigh: null,
    upLimit: null,
    downLimit: null,
    ma5: null,
    exitSignalHit: false,
    ...overrides,
  };
}

function makeSignal(
  tsCode: string,
  signalDate: string,
  buyDate: string,
  exitDate: string,
  buyPrice: number,
  exitPrice: number,
  extraDays?: Partial<HoldingDaySnapshot>[],
): { signalDate: string; buyDate: string; tsCode: string; simulationInput: SimulationInput } {
  const days: HoldingDaySnapshot[] = [];
  days.push(holdingDay({ calDate: buyDate, qfqOpen: buyPrice, qfqClose: buyPrice, rawOpen: buyPrice * 0.95 }));
  if (extraDays) {
    for (const ed of extraDays) {
      days.push(holdingDay(ed));
    }
  }
  for (let i = days.length; i <= 10; i++) {
    days.push(holdingDay({
      calDate: exitDate,
      qfqOpen: exitPrice,
      qfqClose: exitPrice,
    }));
  }
  return {
    signalDate,
    buyDate,
    tsCode,
    simulationInput: {
      tsCode,
      signalDate,
      days,
      daysSinceList: 1000,
      delistDate: null,
      exit: { mode: 'fixed_n', horizonN: 1 },
    },
  };
}

const defaultRegimeConfig: RegimeConfigMap = {
  Q1: { action: 'trade', exitMode: 'fixed_n', exitParams: { N: 1 } },
  Q2: { action: 'flat' },
  Q3: { action: 'trade', exitMode: 'fixed_n', exitParams: { N: 1 } },
  Q4: { action: 'trade', exitMode: 'fixed_n', exitParams: { N: 1 } },
};

function baseInput(overrides: Partial<RegimeBacktestInput> = {}): RegimeBacktestInput {
  return {
    regimeConfig: defaultRegimeConfig,
    capital: {
      initialCapital: 1_000_000,
      cost: COST_PRESET_ZERO,
      positionRatio: 0.1,
      maxPositions: null,
    },
    calendar: ['20260101', '20260102', '20260103', '20260104', '20260105'],
    oamvDaily: new Map<string, { amvDif: number | null; amvDea: number | null; amvMacd: number | null }>(),
    signalsByDate: new Map(),
    ...overrides,
  };
}

describe('regime-backtest.engine', () => {
  it('Q1 trade: signal taken, exit, nav correct', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      oamvDaily: new Map([['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades.length).toBe(1);
    const t = result.trades[0];
    expect(t.status).toBe('taken');
    expect(t.regime).toBe('Q1');
    expect(t.ret).toBeCloseTo(0.1);

    expect(result.dailyRows[0].nav).toBe(1_000_000);
    expect(result.dailyRows[1].nav).toBe(1_000_000);
    expect(result.dailyRows[2].nav).toBeCloseTo(1_010_000);

    expect(result.summary.nTaken).toBe(1);
    expect(result.summary.finalNav).toBeCloseTo(1_010_000);
  });

  it('Q2 flat: signal skipped as regime_flat', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      oamvDaily: new Map([['20260101', { amvDif: 1, amvDea: 0, amvMacd: -1 }]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].status).toBe('skipped');
    expect(result.trades[0].skipReason).toBe('regime_flat');
    expect(result.summary.nTaken).toBe(0);
    expect(result.summary.nSkipped).toBe(1);
  });

  it('unknown regime (no oamv): signal skipped as regime_flat', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      oamvDaily: new Map(),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades[0].status).toBe('skipped');
    expect(result.trades[0].skipReason).toBe('regime_flat');
  });

  it('cooldown: consecutive losses freeze trading', () => {
    const signal1 = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 9);
    const signal2 = makeSignal('000002.SZ', '20260101', '20260102', '20260103', 10, 9);
    const signal3 = makeSignal('000003.SZ', '20260101', '20260102', '20260103', 10, 9);
    const signal4 = makeSignal('000004.SZ', '20260103', '20260104', '20260105', 10, 11);

    const input = baseInput({
      capital: {
        initialCapital: 10_000_000,
        cost: COST_PRESET_ZERO,
        positionRatio: 0.1,
        maxPositions: null,
        circuitBreaker: {
          enableCooldown: true,
          consecutiveLossesThreshold: 2,
          baseCooldownDays: 2,
          maxCooldownDays: 10,
          extendOnLoss: 1,
          reduceOnProfit: 1,
          enableDrawdownHalt: false,
          drawdownHaltPct: 0.15,
          drawdownResumePct: 0.1,
        },
      },
      oamvDaily: new Map([
        ['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }],
        ['20260103', { amvDif: 1, amvDea: 0, amvMacd: 1 }],
      ]),
      signalsByDate: new Map([
        ['20260101', [signal1, signal2, signal3]],
        ['20260103', [signal4]],
      ]),
    });

    const result = runRegimeBacktest(input);
    const day1Trades = result.trades.filter((t) => t.signalDate === '20260101');
    expect(day1Trades.length).toBe(3);
    expect(day1Trades.every((t) => t.status === 'taken')).toBe(true);

    const day2Trades = result.trades.filter((t) => t.signalDate === '20260103');
    expect(day2Trades.length).toBe(1);
    expect(day2Trades[0].skipReason).toBe('cooldown');
  });

  it('cost deduction affects realizedRetNet', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      capital: {
        initialCapital: 1_000_000,
        cost: {
          commissionPerSide: 0.001,
          transferPerSide: 0,
          stampSellBefore20230828: 0.001,
          stampSellFrom20230828: 0.0005,
          slippagePerSide: 0,
        },
        positionRatio: 0.1,
        maxPositions: null,
      },
      oamvDaily: new Map([['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    const t = result.trades[0];
    expect(t.status).toBe('taken');
    expect(t.ret).toBeCloseTo(0.1);
    expect(t.realizedRetNet!).toBeLessThan(0.1);
    expect(t.costsPaid!).toBeGreaterThan(0);
  });

  it('same-day round-trip (exitDate == buyDate)', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260102', 10, 11);
    const input = baseInput({
      oamvDaily: new Map([['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades[0].status).toBe('taken');
    expect(result.dailyRows[1].positionCount).toBe(0);
    expect(result.dailyRows[1].cash).toBe(1_010_000);
  });

  it('mark-to-market: NAV reflects floating P&L before exit', () => {
    // horizonN=2 → exit on days[2]
    // days[0]=buyDate(20260102) open=10 close=10
    // days[1]=20260103 close=12 (+20%)
    // days[2]=20260104 close=11 → exitDate=20260104, exitPrice=11, ret=0.1
    const signal = makeSignal(
      '000001.SZ', '20260101', '20260102', '20260104',
      10, 11,
      [
        { calDate: '20260103', qfqOpen: 11, qfqClose: 12 },
        { calDate: '20260104', qfqOpen: 12, qfqClose: 11 },
      ],
    );
    // Override exit horizon to 2
    signal.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };
    const input = baseInput({
      calendar: ['20260101', '20260102', '20260103', '20260104', '20260105'],
      oamvDaily: new Map([
        ['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }],
      ]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades[0].status).toBe('taken');
    expect(result.trades[0].exitDate).toBe('20260104');

    // Day 0 (20260101): no position, nav=1M
    expect(result.dailyRows[0].nav).toBe(1_000_000);
    // Day 1 (20260102): bought 100K at open=10, close=10 → mv=100K, nav=1M
    expect(result.dailyRows[1].nav).toBe(1_000_000);
    // Day 2 (20260103): mark-to-market, close=12 → mv=100K*12/10=120K, nav=900K+120K=1.02M
    expect(result.dailyRows[2].nav).toBeCloseTo(1_020_000);
    // Day 3 (20260104): exit, ret=0.1, gross=110K, cash=1.01M, nav=1.01M
    expect(result.dailyRows[3].nav).toBeCloseTo(1_010_000);
  });

  it('drawdown_halt: freezes on 10% drawdown, resumes on recovery', () => {
    // Day 0 (20260101): signal A → buy, positionRatio=0.5, alloc=500K
    // Day 1 (20260102): mark-to-market, mv unchanged
    // Day 2 (20260103): A exits (ret=-0.7, gross=150K), cash=650K, nav=650K
    //   After close: peak still 1M, prevNav=650K → dd = -0.35
    // Day 3 (20260104): signal B processed, ddNow=prevNav/peak-1 = 650K/1M-1 = -0.35
    //   → drawdownHaltPct=0.1, ddNow <= -0.1 → halted, B skipped
    const signalA = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 3);
    const signalB = makeSignal('000002.SZ', '20260104', '20260105', '20260106', 10, 11);

    const input = baseInput({
      calendar: ['20260101', '20260102', '20260103', '20260104', '20260105'],
      capital: {
        initialCapital: 1_000_000,
        cost: COST_PRESET_ZERO,
        positionRatio: 0.5,
        maxPositions: null,
        circuitBreaker: {
          enableCooldown: false,
          consecutiveLossesThreshold: 2,
          baseCooldownDays: 2,
          maxCooldownDays: 10,
          extendOnLoss: 1,
          reduceOnProfit: 1,
          enableDrawdownHalt: true,
          drawdownHaltPct: 0.1,
          drawdownResumePct: 0.05,
        },
      },
      oamvDaily: new Map([
        ['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }],
        ['20260104', { amvDif: 1, amvDea: 0, amvMacd: 1 }],
      ]),
      signalsByDate: new Map([
        ['20260101', [signalA]],
        ['20260104', [signalB]],
      ]),
    });

    const result = runRegimeBacktest(input);
    const tradeA = result.trades.find((t) => t.tsCode === '000001.SZ');
    expect(tradeA!.status).toBe('taken');

    const tradeB = result.trades.find((t) => t.tsCode === '000002.SZ');
    expect(tradeB!.status).toBe('skipped');
    expect(tradeB!.skipReason).toBe('drawdown_halt');
  });

  it('slots_full: maxPositions=1, second signal skipped', () => {
    // Both signals same signalDate/buyDate, horizonN=2, exit on 20260104
    const signalA = makeSignal(
      '000001.SZ', '20260101', '20260102', '20260104',
      10, 11,
      [{ calDate: '20260103', qfqOpen: 10, qfqClose: 10 }],
    );
    signalA.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };
    const signalB = makeSignal(
      '000002.SZ', '20260101', '20260102', '20260104',
      10, 11,
      [{ calDate: '20260103', qfqOpen: 10, qfqClose: 10 }],
    );
    signalB.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };

    const input = baseInput({
      capital: {
        initialCapital: 1_000_000,
        cost: COST_PRESET_ZERO,
        positionRatio: 0.1,
        maxPositions: 1,
      },
      oamvDaily: new Map([['20260101', { amvDif: 1, amvDea: 0, amvMacd: 1 }]]),
      signalsByDate: new Map([['20260101', [signalA, signalB]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades.length).toBe(2);
    expect(result.trades[0].status).toBe('taken');
    expect(result.trades[0].tsCode).toBe('000001.SZ');
    expect(result.trades[1].status).toBe('skipped');
    expect(result.trades[1].skipReason).toBe('slots_full');
    expect(result.summary.nTaken).toBe(1);
    expect(result.summary.nSkipped).toBe(1);
  });
});
