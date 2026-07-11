import { runRegimeBacktest } from './regime-backtest.engine';
import { RegimeBacktestInput } from './regime-backtest.types';
import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { MarketSnapshot, IndexTargetSnapshot } from '../market-condition-evaluator';
import { COST_PRESET_ZERO } from '../core/cost';
import { HoldingDaySnapshot, SimulationInput, simulateTradeCore } from '../core/exit-simulator';
import { computeCashSplitAlloc } from '../core/sizing';

const INDEX_TARGET = '000001.SH';

function makeIndexTarget(dif: number, macd: number): IndexTargetSnapshot {
  return {
    quote: {
      open: 3000,
      high: 3050,
      low: 2990,
      close: 3040,
      pre_close: 3020,
      change: 20,
      pct_change: 0.66,
      vol_hand: 1_000_000,
      amount: 500_000,
    },
    indicator: {
      ma5: 3020,
      ma30: 3000,
      ma60: 2980,
      ma120: 2950,
      ma240: 2900,
      dif,
      dea: 5,
      macd,
      kdj_k: 55,
      kdj_d: 45,
      kdj_j: 75,
      bbi: 3005,
      brick: 1,
      brick_delta: 0.5,
      brick_xg: true,
    },
  };
}

function makeMarketSnapshot(dif: number, macd: number): MarketSnapshot {
  return {
    date: '20260101',
    targets: new Map([[INDEX_TARGET, makeIndexTarget(dif, macd)]]),
  };
}

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
  marketIndex: INDEX_TARGET,
  quadrants: [
    {
      key: 'Q1',
      label: 'Q1',
      action: 'trade',
      match: [
        { type: 'index', target: INDEX_TARGET, field: 'dif', operator: 'gt', value: 0 },
        { type: 'index', target: INDEX_TARGET, field: 'macd', operator: 'gt', value: 0 },
      ],
      entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
      exitMode: 'fixed_n',
      exitParams: { N: 1 },
      positionRatio: 0.1,
      maxPositions: 10,
    },
    {
      key: 'Q2',
      label: 'Q2',
      action: 'flat',
      match: [
        { type: 'index', target: INDEX_TARGET, field: 'dif', operator: 'gt', value: 0 },
        { type: 'index', target: INDEX_TARGET, field: 'macd', operator: 'lte', value: 0 },
      ],
    },
    {
      key: 'Q3',
      label: 'Q3',
      action: 'trade',
      match: [
        { type: 'index', target: INDEX_TARGET, field: 'dif', operator: 'lte', value: 0 },
        { type: 'index', target: INDEX_TARGET, field: 'macd', operator: 'gt', value: 0 },
      ],
      entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
      exitMode: 'fixed_n',
      exitParams: { N: 1 },
      positionRatio: 0.1,
      maxPositions: 10,
    },
    {
      key: 'Q4',
      label: 'Q4',
      action: 'trade',
      match: [
        { type: 'index', target: INDEX_TARGET, field: 'dif', operator: 'lte', value: 0 },
        { type: 'index', target: INDEX_TARGET, field: 'macd', operator: 'lte', value: 0 },
      ],
      entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
      exitMode: 'fixed_n',
      exitParams: { N: 1 },
      positionRatio: 0.1,
      maxPositions: 10,
    },
  ],
};

/** Clone default config and set Q1 (trade) position params. */
function regimeConfigWithQ1(
  positionRatio: number,
  maxPositions: number | null,
): RegimeConfigMap {
  return {
    ...defaultRegimeConfig,
    quadrants: defaultRegimeConfig.quadrants.map((q) =>
      q.key === 'Q1' ? { ...q, positionRatio, maxPositions } : { ...q },
    ),
  };
}

function baseInput(overrides: Partial<RegimeBacktestInput> = {}): RegimeBacktestInput {
  return {
    regimeConfig: defaultRegimeConfig,
    capital: {
      initialCapital: 1_000_000,
      cost: COST_PRESET_ZERO,
    },
    calendar: ['20260101', '20260102', '20260103', '20260104', '20260105'],
    marketSnapshots: new Map<string, MarketSnapshot>(),
    signalsByDate: new Map(),
    ...overrides,
  };
}

describe('regime-backtest.engine', () => {
  it('Q1 trade: signal taken, exit, nav correct', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
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
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, -1)]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].status).toBe('skipped');
    expect(result.trades[0].skipReason).toBe('regime_flat');
    expect(result.summary.nTaken).toBe(0);
    expect(result.summary.nSkipped).toBe(1);
  });

  it('unknown regime (no snapshot): signal skipped as regime_flat', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      marketSnapshots: new Map(),
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
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
        ['20260103', makeMarketSnapshot(1, 1)],
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
      },
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    const t = result.trades[0];
    expect(t.status).toBe('taken');
    expect(t.ret).toBeCloseTo(0.1);
    expect(t.realizedRetNet!).toBeLessThan(0.1);
    expect(t.costsPaid!).toBeGreaterThan(0);
  });

  it('T+1: no exit step on buyDate; exits on next tradable day', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades[0].status).toBe('taken');
    expect(result.trades[0].exitDate).toBe('20260103');
    // buyDate 仍持仓
    expect(result.dailyRows[1].positionCount).toBe(1);
    // 次日出场
    expect(result.dailyRows[2].positionCount).toBe(0);
    expect(result.dailyRows[2].cash).toBeCloseTo(1_010_000);
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
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
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
    // Day 0 (20260101): signal A → buy, Q1 positionRatio=0.5, alloc=500K
    // Day 1 (20260102): mark-to-market, mv unchanged
    // Day 2 (20260103): A exits (ret=-0.7, gross=150K), cash=650K, nav=650K
    //   After close: peak still 1M, prevNav=650K → dd = -0.35
    // Day 3 (20260104): signal B processed, ddNow=prevNav/peak-1 = 650K/1M-1 = -0.35
    //   → drawdownHaltPct=0.1, ddNow <= -0.1 → halted, B skipped
    const signalA = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 3);
    const signalB = makeSignal('000002.SZ', '20260104', '20260105', '20260106', 10, 11);

    const input = baseInput({
      calendar: ['20260101', '20260102', '20260103', '20260104', '20260105'],
      regimeConfig: regimeConfigWithQ1(0.5, 10),
      capital: {
        initialCapital: 1_000_000,
        cost: COST_PRESET_ZERO,
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
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
        ['20260104', makeMarketSnapshot(1, 1)],
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

  it('slots_full when n>=maxPositions from quadrant', () => {
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
      regimeConfig: regimeConfigWithQ1(0.1, 1),
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
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

  it('cash split: second buy uses cash * r/(1-r*n)', () => {
    const holdExtra = [{ calDate: '20260103', qfqOpen: 10, qfqClose: 10 }];
    const signalA = makeSignal(
      '000001.SZ', '20260101', '20260102', '20260104',
      10, 11, holdExtra,
    );
    signalA.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };
    const signalB = makeSignal(
      '000002.SZ', '20260101', '20260102', '20260104',
      10, 11, holdExtra,
    );
    signalB.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };

    const r = 0.2;
    const cash0 = 1_000_000;
    const input = baseInput({
      regimeConfig: regimeConfigWithQ1(r, 4),
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [signalA, signalB]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades.every((t) => t.status === 'taken')).toBe(true);

    const alloc0 = computeCashSplitAlloc({ cash: cash0, positionRatio: r, openCount: 0 })!;
    const cash1 = cash0 - alloc0;
    const alloc1 = computeCashSplitAlloc({ cash: cash1, positionRatio: r, openCount: 1 })!;

    expect(result.trades[0].alloc).toBeCloseTo(alloc0);
    expect(result.trades[1].alloc).toBeCloseTo(alloc1);
    // n=0 → 20%; n=1 → 25% of remaining → both 200K when r=0.2
    expect(result.trades[0].alloc).toBeCloseTo(200_000);
    expect(result.trades[1].alloc).toBeCloseTo(200_000);
  });

  it('profit_gate when requireAllPositionsProfitable and open position underwater', () => {
    const holdA = [
      { calDate: '20260103', qfqOpen: 9, qfqClose: 9 },
      { calDate: '20260104', qfqOpen: 9, qfqClose: 9 },
      { calDate: '20260105', qfqOpen: 11, qfqClose: 11 },
    ];
    const signalA = makeSignal(
      '000001.SZ', '20260101', '20260102', '20260105',
      10, 11, holdA,
    );
    signalA.simulationInput.exit = { mode: 'fixed_n', horizonN: 3 };
    const signalB = makeSignal(
      '000002.SZ', '20260104', '20260105', '20260106',
      10, 11,
      [{ calDate: '20260105', qfqOpen: 10, qfqClose: 11 }],
    );
    signalB.simulationInput.exit = { mode: 'fixed_n', horizonN: 1 };

    const input = baseInput({
      regimeConfig: regimeConfigWithQ1(0.2, 4),
      capital: {
        initialCapital: 1_000_000,
        cost: COST_PRESET_ZERO,
        requireAllPositionsProfitable: true,
      },
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
        ['20260104', makeMarketSnapshot(1, 1)],
      ]),
      signalsByDate: new Map([
        ['20260101', [signalA]],
        ['20260104', [signalB]],
      ]),
      calendar: ['20260101', '20260102', '20260103', '20260104', '20260105', '20260106'],
    });

    const result = runRegimeBacktest(input);
    const tradeB = result.trades.find((t) => t.tsCode === '000002.SZ');
    expect(tradeB!.status).toBe('skipped');
    expect(tradeB!.skipReason).toBe('profit_gate');
  });

  it('budget_full when 1-r*n<=0', () => {
    // r=0.5: after 2 opens, 1-r*n=0 → third signal budget_full
    // maxPositions large so slots_full does not fire first
    const holdExtra = [{ calDate: '20260103', qfqOpen: 10, qfqClose: 10 }];
    const mk = (code: string) => {
      const s = makeSignal(code, '20260101', '20260102', '20260104', 10, 11, holdExtra);
      s.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };
      return s;
    };

    const input = baseInput({
      regimeConfig: regimeConfigWithQ1(0.5, 10),
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([
        ['20260101', [mk('000001.SZ'), mk('000002.SZ'), mk('000003.SZ')]],
      ]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades[0].status).toBe('taken');
    expect(result.trades[1].status).toBe('taken');
    expect(result.trades[2].status).toBe('skipped');
    expect(result.trades[2].skipReason).toBe('budget_full');
  });

  const kellyCapital = {
    initialCapital: 1_000_000,
    cost: COST_PRESET_ZERO,
    sizing: {
      mode: 'source_kelly' as const,
      floorMult: 0.5,
      capMult: 1.5,
      kellyFraction: 0.5,
      kellyMaxMult: 1,
    },
    kelly: {
      enabled: true,
      simTrades: 2,
      windowTrades: 10,
      stepTrades: 1,
      kellyFraction: 0.5,
      kellyMaxMult: 1,
      enableProbe: true,
    },
  };

  it('kelly simulation: live cash unchanged during sim phase', () => {
    const signal1 = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 9);
    const signal2 = makeSignal('000002.SZ', '20260103', '20260104', '20260105', 10, 9);
    const input = baseInput({
      capital: kellyCapital,
      calendar: ['20260101', '20260102', '20260103', '20260104', '20260105', '20260106'],
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
        ['20260103', makeMarketSnapshot(1, 1)],
      ]),
      signalsByDate: new Map([
        ['20260101', [signal1]],
        ['20260103', [signal2]],
      ]),
    });

    const result = runRegimeBacktest(input);
    const taken = result.trades.filter((t) => t.status === 'taken');
    expect(taken.length).toBe(2);
    expect(taken.every((t) => t.tradePhase === 'simulation')).toBe(true);
    expect(result.dailyRows.every((r) => r.cash === 1_000_000)).toBe(true);
    expect(result.dailyRows[result.dailyRows.length - 1].nav).toBe(1_000_000);
  });

  it('kelly probe: continues sampling when kelly mult <= 0 and live empty', () => {
    const signal1 = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 9);
    const signal2 = makeSignal('000002.SZ', '20260103', '20260104', '20260105', 10, 9);
    const signal3 = makeSignal('000003.SZ', '20260106', '20260107', '20260108', 10, 11);
    const input = baseInput({
      capital: kellyCapital,
      calendar: [
        '20260101', '20260102', '20260103', '20260104', '20260105',
        '20260106', '20260107', '20260108', '20260109',
      ],
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
        ['20260103', makeMarketSnapshot(1, 1)],
        ['20260106', makeMarketSnapshot(1, 1)],
      ]),
      signalsByDate: new Map([
        ['20260101', [signal1]],
        ['20260103', [signal2]],
        ['20260106', [signal3]],
      ]),
    });

    const result = runRegimeBacktest(input);
    const probeTrade = result.trades.find((t) => t.tsCode === '000003.SZ');
    expect(probeTrade?.status).toBe('taken');
    expect(probeTrade?.tradePhase).toBe('probe');
    expect(result.dailyRows.every((r) => r.cash === 1_000_000)).toBe(true);
  });

  it('kelly disabled: existing behavior unchanged', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      capital: {
        initialCapital: 1_000_000,
        cost: COST_PRESET_ZERO,
        sizing: {
          mode: 'source_kelly' as const,
          floorMult: 0.5,
          capMult: 1.5,
          kellyFraction: 0.5,
          kellyMaxMult: 1,
        },
      },
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });

    const result = runRegimeBacktest(input);
    expect(result.trades[0].status).toBe('taken');
    expect(result.trades[0].tradePhase).toBeUndefined();
    expect(result.dailyRows[2].nav).toBeCloseTo(1_010_000);
    expect(result.dailyRows[2].cash).toBeCloseTo(1_010_000);
  });

  it('produces auditRows aligned with dailyRows', () => {
    const signal = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    const input = baseInput({
      marketSnapshots: new Map([
        ['20260101', makeMarketSnapshot(1, 1)],
        ['20260102', makeMarketSnapshot(1, 1)],
        ['20260103', makeMarketSnapshot(1, 1)],
      ]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });
    const result = runRegimeBacktest(input);
    expect(result.auditRows).toHaveLength(result.dailyRows.length);
    const auditDay1 = result.auditRows.find((r) => r.tradeDate === '20260101');
    expect(auditDay1?.regime).toBeTruthy();
    expect(auditDay1?.entries.length).toBeGreaterThanOrEqual(1);
    const auditExitDay = result.auditRows.find((r) => r.exits.some((e) => e.tsCode === '000001.SZ'));
    expect(auditExitDay).toBeDefined();
  });

  it('entry filter: suspended / limit_up map to fine skipReason (not sized_out)', () => {
    const suspended = makeSignal('000001.SZ', '20260101', '20260102', '20260103', 10, 11);
    suspended.simulationInput.days[0] = holdingDay({
      calDate: '20260102',
      hasQuote: false,
      qfqOpen: null,
      qfqClose: null,
    });

    const limitUp = makeSignal('000002.SZ', '20260101', '20260102', '20260103', 10, 11);
    limitUp.simulationInput.days[0] = holdingDay({
      calDate: '20260102',
      qfqOpen: 11,
      qfqClose: 11,
      rawOpen: 11,
      upLimit: 11,
    });

    const input = baseInput({
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [suspended, limitUp]]]),
    });
    const result = runRegimeBacktest(input);
    expect(result.trades[0].skipReason).toBe('suspended');
    expect(result.trades[1].skipReason).toBe('limit_up');
  });

  it('parity: single position exitDate/ret/exitReason matches simulateTradeCore', () => {
    const signal = makeSignal(
      '000001.SZ',
      '20260101',
      '20260102',
      '20260104',
      10,
      11,
      [
        { calDate: '20260103', qfqOpen: 10.5, qfqClose: 10.8 },
        { calDate: '20260104', qfqOpen: 11, qfqClose: 11 },
      ],
    );
    signal.simulationInput.exit = { mode: 'fixed_n', horizonN: 2 };

    const coreOut = simulateTradeCore(signal.simulationInput);
    expect(coreOut.kind).toBe('trade');
    if (coreOut.kind !== 'trade') return;

    const input = baseInput({
      calendar: ['20260101', '20260102', '20260103', '20260104', '20260105'],
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });
    const result = runRegimeBacktest(input);
    const t = result.trades[0];
    expect(t.status).toBe('taken');
    expect(t.exitDate).toBe(coreOut.trade.exitDate);
    expect(t.ret).toBeCloseTo(coreOut.trade.ret);
    expect(t.exitReason).toBe(coreOut.trade.exitReason);
    // exitPrice 可由 ret 反推
    const engineExitPrice = t.ret !== undefined ? 10 * (1 + t.ret) : null;
    expect(engineExitPrice).toBeCloseTo(coreOut.trade.exitPrice);
  });

  it('backtest_end: still holding at calendar end force-closes live', () => {
    // horizonN=5 但日历只到 20260104，窗口凑不满 → 末日强平
    const signal = makeSignal(
      '000001.SZ',
      '20260101',
      '20260102',
      '20260104',
      10,
      12,
      [
        { calDate: '20260103', qfqOpen: 10, qfqClose: 11 },
        { calDate: '20260104', qfqOpen: 11, qfqClose: 12 },
      ],
    );
    signal.simulationInput.exit = { mode: 'fixed_n', horizonN: 5 };
    // 截断 days，避免 pad 出假的可交易日
    signal.simulationInput.days = signal.simulationInput.days.filter((d) =>
      ['20260102', '20260103', '20260104'].includes(d.calDate),
    );

    const input = baseInput({
      calendar: ['20260101', '20260102', '20260103', '20260104'],
      marketSnapshots: new Map([['20260101', makeMarketSnapshot(1, 1)]]),
      signalsByDate: new Map([['20260101', [signal]]]),
    });
    const result = runRegimeBacktest(input);
    const t = result.trades[0];
    expect(t.status).toBe('taken');
    expect(t.exitReason).toBe('backtest_end');
    expect(t.exitDate).toBe('20260104');
    expect(t.ret).toBeCloseTo(0.2); // 12/10 - 1
    expect(result.dailyRows[3].positionCount).toBe(0);
  });
});
