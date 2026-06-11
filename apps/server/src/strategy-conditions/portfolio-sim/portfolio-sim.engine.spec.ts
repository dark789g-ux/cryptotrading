/**
 * portfolio-sim.engine.spec.ts
 *
 * 组合级模拟器逐日回放引擎单测，覆盖 spec 05 清单 11 项：
 *  1. 同日超额排序取前 K（rank/平局/缺失）
 *  2. already_held（含出场当日可再进）
 *  3. exposureCap 撞线（严格 >）
 *  4. cash_short 整笔跳过
 *  5. 停牌沿价盯市
 *  6. 印花税时变出场
 *  7. 零命中日 / 跨年 / 单笔最小
 *  8. 出场收口恒等（1+ret）
 *  9. 成本单调性（三档 + 零成本 net=ret）
 * 10. 约束单调性（maxPositions 5→3→1）
 * 11. 汇总指标手算（maxDrawdown/annualRet/sharpe/dailyKelly）
 *
 * 全部用构造的内存数据驱动，不连 DB。
 */

import {
  runPortfolioSim,
  sortCandidates,
  TRADING_DAYS_PER_YEAR,
} from './portfolio-sim.engine';
import {
  COST_PRESET_CONSERVATIVE,
  COST_PRESET_OPTIMISTIC,
  COST_PRESET_REALISTIC,
  COST_PRESET_ZERO,
} from './portfolio-sim.cost';
import {
  EngineInput,
  EngineQuoteBar,
  EngineTrade,
  PortfolioSimConfig,
  PortfolioSimCostRates,
  PortfolioSimSource,
} from './portfolio-sim.types';

// ─────────────────────────────────────────────────────────────────────────────
// 构造辅助
// ─────────────────────────────────────────────────────────────────────────────

function source(overrides: Partial<PortfolioSimSource> = {}): PortfolioSimSource {
  return {
    runId: 'run-a',
    label: 'A',
    positionRatio: 0.1,
    maxPositions: null,
    exposureCap: null,
    rankField: 'none',
    rankDir: 'asc',
    ...overrides,
  };
}

function trade(overrides: Partial<EngineTrade> = {}): EngineTrade {
  return {
    sourceIdx: 0,
    tsCode: '000001.SZ',
    signalDate: '20260101',
    buyDate: '20260102',
    exitDate: '20260103',
    ret: 0,
    holdDays: 1,
    rankValue: null,
    ...overrides,
  };
}

function config(
  sources: PortfolioSimSource[],
  overrides: Partial<PortfolioSimConfig> = {},
): PortfolioSimConfig {
  return {
    sources,
    initialCapital: 1_000_000,
    cost: COST_PRESET_ZERO,
    anchorMode: false,
    ...overrides,
  };
}

/**
 * 构造每个 tsCode 的行情 Map。bars: { tsCode: { date: [open, close] } }。
 * 缺日 = 停牌。
 */
function buildQuotes(
  bars: Record<string, Record<string, [number, number]>>,
): Map<string, Map<string, EngineQuoteBar>> {
  const m = new Map<string, Map<string, EngineQuoteBar>>();
  for (const [ts, byDate] of Object.entries(bars)) {
    const inner = new Map<string, EngineQuoteBar>();
    for (const [date, [open, close]] of Object.entries(byDate)) {
      inner.set(date, { open, close });
    }
    m.set(ts, inner);
  }
  return m;
}

function input(partial: Partial<EngineInput> & { config: PortfolioSimConfig }): EngineInput {
  return {
    trades: [],
    quotes: new Map(),
    calendar: [],
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 同日超额：rank 排序取前 K、平局 ts_code、缺失置后
// ─────────────────────────────────────────────────────────────────────────────
describe('1. 同日超额排序（sortCandidates + slots_full）', () => {
  it('sortCandidates：desc 排序，缺失置后，平局 ts_code 升序', () => {
    const src = source({ rankField: 'pos_120', rankDir: 'desc' });
    const ts = [
      trade({ tsCode: 'C', rankValue: 5 }),
      trade({ tsCode: 'A', rankValue: 10 }),
      trade({ tsCode: 'D', rankValue: null }), // 缺失
      trade({ tsCode: 'B', rankValue: 10 }), // 与 A 平局
      trade({ tsCode: 'E', rankValue: null }), // 缺失
    ];
    const sorted = sortCandidates(ts, src);
    // desc：10 的两个在前（平局 A<B），然后 5，最后缺失 D<E
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('rankField=none：纯按 ts_code 升序', () => {
    const src = source({ rankField: 'none' });
    const ts = [
      trade({ tsCode: 'C', rankValue: 100 }),
      trade({ tsCode: 'A', rankValue: 1 }),
      trade({ tsCode: 'B', rankValue: 50 }),
    ];
    expect(sortCandidates(ts, src).map((t) => t.tsCode)).toEqual(['A', 'B', 'C']);
  });

  it('maxPositions=2：同日 3 候选取 rank 最优 2 个，第 3 个 slots_full', () => {
    const src = source({
      rankField: 'pos_120',
      rankDir: 'desc',
      maxPositions: 2,
      positionRatio: 0.1,
    });
    const trades = [
      trade({ tsCode: 'LOW', rankValue: 1, exitDate: '20260110' }),
      trade({ tsCode: 'HIGH', rankValue: 9, exitDate: '20260110' }),
      trade({ tsCode: 'MID', rankValue: 5, exitDate: '20260110' }),
    ];
    const quotes = buildQuotes({
      LOW: { '20260102': [10, 10] },
      HIGH: { '20260102': [10, 10] },
      MID: { '20260102': [10, 10] },
    });
    const res = runPortfolioSim(
      input({ config: config([src]), trades, quotes, calendar: ['20260102'] }),
    );
    const byTs = new Map(res.fills.map((f) => [f.tsCode, f]));
    expect(byTs.get('HIGH')!.status).toBe('taken');
    expect(byTs.get('MID')!.status).toBe('taken');
    expect(byTs.get('LOW')!.status).toBe('skipped');
    expect(byTs.get('LOW')!.skipReason).toBe('slots_full');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. already_held（含出场当日可再进）
// ─────────────────────────────────────────────────────────────────────────────
describe('2. already_held', () => {
  it('同策略在持同票新信号 → already_held', () => {
    const src = source({ positionRatio: 0.1 });
    // 第一笔 20260102 买、20260110 卖；第二笔同票 20260103 买（仍在持）→ already_held
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110' }),
      trade({ tsCode: 'X', buyDate: '20260103', exitDate: '20260111' }),
    ];
    const quotes = buildQuotes({
      X: {
        '20260102': [10, 10],
        '20260103': [10, 10],
      },
    });
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    expect(res.fills[0].status).toBe('taken');
    expect(res.fills[1].status).toBe('skipped');
    expect(res.fills[1].skipReason).toBe('already_held');
  });

  it('出场当日新信号可再进（先出场后开仓）', () => {
    const src = source({ positionRatio: 0.1 });
    // 第一笔 20260102 买、20260103 卖；第二笔同票 20260103 买（出场当日）→ 应 taken
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260103' }),
      trade({ tsCode: 'X', buyDate: '20260103', exitDate: '20260104' }),
    ];
    const quotes = buildQuotes({
      X: {
        '20260102': [10, 10],
        '20260103': [10, 10],
        '20260104': [10, 10],
      },
    });
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes,
        calendar: ['20260102', '20260103', '20260104'],
      }),
    );
    expect(res.fills[0].status).toBe('taken');
    // 第一笔 20260103 已出场 → 第二笔同日开仓不应 already_held
    expect(res.fills[1].status).toBe('taken');
  });

  it('检查顺序优先级：already_held 先于 slots_full（同票且槽满 → 报 already_held）', () => {
    // maxPositions=1：先持有 X；同日再来一笔 X（既 already_held 又槽满）→ 应报 already_held（最先检查）。
    const src = source({ positionRatio: 0.1, maxPositions: 1, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110' }),
      trade({ tsCode: 'X', buyDate: '20260103', exitDate: '20260111' }),
    ];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 10] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    expect(res.fills[1].status).toBe('skipped');
    expect(res.fills[1].skipReason).toBe('already_held'); // 非 slots_full
  });

  it('检查顺序优先级：slots_full 先于 exposure_cap（异票槽满 → 报 slots_full）', () => {
    // positionRatio=0.1、exposureCap=0.1、maxPositions=1：
    //   第一笔 X：projected=0.1 == cap 放行、占满唯一槽位。
    //   第二笔异票 Y：slots_full（ownLen=1>=1）先命中，exposure_cap((0.1+0.1)/1=0.2>0.1) 在其后 → 报 slots_full。
    const src = source({
      positionRatio: 0.1,
      maxPositions: 1,
      exposureCap: 0.1,
      rankField: 'none',
    });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110' }),
      trade({ tsCode: 'Y', buyDate: '20260103', exitDate: '20260111' }),
    ];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 10] },
      Y: { '20260103': [10, 10] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    const yFill = res.fills.find((f) => f.tsCode === 'Y')!;
    expect(yFill.status).toBe('skipped');
    expect(yFill.skipReason).toBe('slots_full'); // 非 exposure_cap
  });

  it('检查顺序优先级：exposure_cap 先于 cash_short（同时满足时报 cap）', () => {
    // positionRatio=0.6、exposureCap=0.6、maxPositions=null：
    //   第一笔 X：ownMv=0，projected=0.6 == cap 放行 → 开仓，cash 剩 0.4e6（同价 mv 恒 0.6e6）。
    //   第二笔异票 Y（次日 navRef=1e6）：
    //     exposure_cap：(0.6e6 + 0.6e6)/1e6 = 1.2 > 0.6 → 命中；
    //     cash_short：  cash 0.4e6 < alloc 0.6e6 → 也命中；
    //   按检查顺序应报 exposure_cap（先于 cash_short）。
    const src = source({
      positionRatio: 0.6,
      maxPositions: null,
      exposureCap: 0.6,
      rankField: 'none',
    });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110' }),
      trade({ tsCode: 'Y', buyDate: '20260103', exitDate: '20260111' }),
    ];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 10] },
      Y: { '20260103': [10, 10] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    expect(res.fills[0].status).toBe('taken'); // X 恰等 cap 放行
    const yFill = res.fills.find((f) => f.tsCode === 'Y')!;
    expect(yFill.status).toBe('skipped');
    expect(yFill.skipReason).toBe('exposure_cap'); // 非 cash_short
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. exposureCap 撞线（严格 >）
// ─────────────────────────────────────────────────────────────────────────────
describe('3. exposureCap 撞线数值用例', () => {
  it('cap=0.33、敞口 0.30、alloc=0.03 → 恰 0.33 放行；再 0.03 → 0.36 skip', () => {
    // positionRatio=0.03（alloc=30000 占 NAV_ref 1e6 的 0.03）。
    // 前 10 笔各 0.03 → 累计敞口 0.30；第 11 笔 → 恰 0.33 放行；第 12 笔 → 0.36 > 0.33 skip。
    // 为避免盯市改变 mv（敞口口径用 mv），所有票 open=close 同价，mv 恒 = alloc。
    const src = source({
      positionRatio: 0.03,
      exposureCap: 0.33,
      maxPositions: null,
      rankField: 'none',
    });
    const trades: EngineTrade[] = [];
    const bars: Record<string, Record<string, [number, number]>> = {};
    for (let i = 0; i < 12; i++) {
      const ts = `T${String(i).padStart(2, '0')}`; // 升序 ts_code 保证处理顺序
      trades.push(trade({ tsCode: ts, buyDate: '20260102', exitDate: '20260120' }));
      bars[ts] = { '20260102': [10, 10] };
    }
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes: buildQuotes(bars),
        calendar: ['20260102'],
      }),
    );
    const taken = res.fills.filter((f) => f.status === 'taken');
    // 0.30 已占 → 第 11 笔恰 0.33 放行 → 共 11 taken；第 12 笔 skip(exposure_cap)
    expect(taken.length).toBe(11);
    const skipped = res.fills.filter((f) => f.status === 'skipped');
    expect(skipped.length).toBe(1);
    expect(skipped[0].skipReason).toBe('exposure_cap');
    // 收盘敞口恰 0.33
    expect(res.dailyRows[0].exposure).toBeCloseTo(0.33, 10);
  });

  it('恰等 cap 放行（断言 > 非 >=）：cap=0.30、累计 0.27、alloc=0.03 → 0.30 放行', () => {
    const src = source({ positionRatio: 0.03, exposureCap: 0.3, rankField: 'none' });
    const trades: EngineTrade[] = [];
    const bars: Record<string, Record<string, [number, number]>> = {};
    for (let i = 0; i < 10; i++) {
      const ts = `T${String(i).padStart(2, '0')}`;
      trades.push(trade({ tsCode: ts, buyDate: '20260102', exitDate: '20260120' }));
      bars[ts] = { '20260102': [10, 10] };
    }
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes: buildQuotes(bars),
        calendar: ['20260102'],
      }),
    );
    // 10 笔各 0.03 = 恰 0.30，全放行（最后一笔成交后 == cap）
    expect(res.fills.filter((f) => f.status === 'taken').length).toBe(10);
    expect(res.dailyRows[0].exposure).toBeCloseTo(0.3, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. cash_short：现金不足整笔跳过（不部分成交）
// ─────────────────────────────────────────────────────────────────────────────
describe('4. cash_short', () => {
  it('现金不足整笔跳过', () => {
    // positionRatio=0.6：第一笔 alloc=0.6e6，cash 余 0.4e6；
    // 第二笔 alloc 仍按 NAV_ref(d)=1e6 算 = 0.6e6 > cash 0.4e6 → cash_short
    const src = source({ positionRatio: 0.6, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'A', buyDate: '20260102', exitDate: '20260120' }),
      trade({ tsCode: 'B', buyDate: '20260102', exitDate: '20260120' }),
    ];
    const quotes = buildQuotes({
      A: { '20260102': [10, 10] },
      B: { '20260102': [10, 10] },
    });
    const res = runPortfolioSim(
      input({ config: config([src]), trades, quotes, calendar: ['20260102'] }),
    );
    const byTs = new Map(res.fills.map((f) => [f.tsCode, f]));
    expect(byTs.get('A')!.status).toBe('taken');
    expect(byTs.get('B')!.status).toBe('skipped');
    expect(byTs.get('B')!.skipReason).toBe('cash_short');
    // 现金 = 1e6 - 0.6e6 = 0.4e6（B 未部分成交）
    expect(res.dailyRows[0].cash).toBeCloseTo(400_000, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 停牌沿价盯市
// ─────────────────────────────────────────────────────────────────────────────
describe('5. 停牌沿价盯市', () => {
  it('盯市窗口中间停牌日 mv 不变，下一行情日仍以最后 close 作分母', () => {
    // 单票、零成本、anchorMode 关。positionRatio=1（满仓便于手算）。
    // 入场 20260102 open=10、close=11 → mv = 1e6 * 11/10 = 1.1e6
    // 20260103 停牌（无行情）→ mv 不变 = 1.1e6
    // 20260104 close=12（分母仍是上一 close 11）→ mv = 1.1e6 * 12/11 = 1.2e6
    // 出场 20260105（exitDate）→ 用 ret 收口；这里只看停牌日 NAV 路径，故 exitDate 设更晚
    const src = source({ positionRatio: 1, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110', ret: 0.2 }),
    ];
    const quotes = buildQuotes({
      X: {
        '20260102': [10, 11],
        // 20260103 停牌
        '20260104': [99, 12], // open 99 无关紧要（非入场首日，分母用上一 close）
      },
    });
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades,
        quotes,
        calendar: ['20260102', '20260103', '20260104'],
      }),
    );
    // 入场日：cash=0，mv=1e6*11/10=1.1e6 → NAV=1.1e6
    expect(res.dailyRows[0].nav).toBeCloseTo(1_100_000, 4);
    // 停牌日：mv 不变 → NAV=1.1e6
    expect(res.dailyRows[1].nav).toBeCloseTo(1_100_000, 4);
    expect(res.dailyRows[1].dailyRet).toBeCloseTo(0, 10);
    // 复牌日：mv=1.1e6*12/11=1.2e6 → NAV=1.2e6
    expect(res.dailyRows[2].nav).toBeCloseTo(1_200_000, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 印花税时变出场
// ─────────────────────────────────────────────────────────────────────────────
describe('6. 印花税时变（exitDate 决定档）', () => {
  // 注：positionRatio<1（留出买费空间）——满仓 alloc==NAV 时任何正买费都会 cash_short。
  function runSingle(exitDate: string, cost: PortfolioSimCostRates) {
    const src = source({ positionRatio: 0.5, rankField: 'none' });
    const buyDate = '20230824';
    const calendar = ['20230824', '20230825', '20230828', '20230829'];
    const trades = [trade({ tsCode: 'X', buyDate, exitDate, ret: 0, signalDate: '20230823' })];
    const bars: Record<string, [number, number]> = {};
    for (const d of calendar) bars[d] = [10, 10];
    const quotes = buildQuotes({ X: bars });
    return runPortfolioSim(
      input({ config: config([src], { cost }), trades, quotes, calendar }),
    );
  }

  it('exitDate=20230825（减半前）卖费按 0.001 印花', () => {
    // alloc=0.5e6、ret=0 → gross=0.5e6。
    const res = runSingle('20230825', COST_PRESET_REALISTIC);
    const fill = res.fills[0];
    expect(fill.status).toBe('taken');
    // 买费 = 0.5e6 * 0.00076 = 380；卖费 = 0.5e6 * (0.00025+0.00001+0.001+0.0005)=0.5e6*0.00176=880
    // costsPaid = 380 + 880 = 1260
    expect(fill.costsPaid).toBeCloseTo(1260, 4);
  });

  it('exitDate=20230828（减半后）卖费按 0.0005 印花', () => {
    const res = runSingle('20230828', COST_PRESET_REALISTIC);
    const fill = res.fills[0];
    expect(fill.status).toBe('taken');
    // 卖费 = 0.5e6 * (0.00025+0.00001+0.0005+0.0005)=0.5e6*0.00126=630；买费 380 → costsPaid=1010
    expect(fill.costsPaid).toBeCloseTo(1010, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 零命中日 / 跨年 / 单笔最小
// ─────────────────────────────────────────────────────────────────────────────
describe('7. 边界：零命中日 / 跨年 / 单笔最小', () => {
  it('零命中日：日历有日但无任何 buy/exit → NAV 恒等 initialCapital、dailyRet=0', () => {
    const src = source();
    const res = runPortfolioSim(
      input({
        config: config([src]),
        trades: [],
        quotes: new Map(),
        calendar: ['20260102', '20260103'],
      }),
    );
    expect(res.dailyRows).toHaveLength(2);
    for (const row of res.dailyRows) {
      expect(row.nav).toBe(1_000_000);
      expect(row.dailyRet).toBeCloseTo(0, 12);
      expect(row.positionCount).toBe(0);
    }
    expect(res.summary.totalRet).toBeCloseTo(0, 12);
    expect(res.summary.nTaken).toBe(0);
  });

  it('单笔最小：1 票 anchorMode 全程，realizedRetNet ≡ ret', () => {
    const src = source({ positionRatio: 0.5 });
    const trades = [trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260103', ret: 0.15 })];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 11.5] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src], { anchorMode: true }),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    expect(res.fills[0].status).toBe('taken');
    expect(res.fills[0].realizedRetNet).toBeCloseTo(0.15, 12);
    expect(res.summary.totalCosts).toBe(0);
  });

  it('跨年窗口：buyDate 2025、exitDate 2026 跨年正常收口', () => {
    const src = source({ positionRatio: 0.5, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'X', signalDate: '20251230', buyDate: '20251231', exitDate: '20260105', ret: 0.1 }),
    ];
    const calendar = ['20251231', '20260102', '20260105'];
    const quotes = buildQuotes({
      X: { '20251231': [10, 10], '20260102': [10, 10], '20260105': [10, 11] },
    });
    const res = runPortfolioSim(
      input({ config: config([src], { anchorMode: true }), trades, quotes, calendar }),
    );
    expect(res.fills[0].status).toBe('taken');
    expect(res.fills[0].realizedRetNet).toBeCloseTo(0.1, 12);
    expect(res.dailyRows).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 出场收口恒等（毛收益恒等 1+ret，盯市路径无关）
// ─────────────────────────────────────────────────────────────────────────────
describe('8. 出场收口恒等', () => {
  it('任意盯市路径下，零成本净实现收益 = ret（构造性）', () => {
    // 入场后剧烈波动（盯市 mv 大幅偏离），但出场收口仍按 alloc*(1+ret)。
    const src = source({ positionRatio: 1, rankField: 'none' });
    const ret = 0.07;
    const trades = [trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260105', ret })];
    const quotes = buildQuotes({
      X: {
        '20260102': [10, 30], // 入场首日暴涨（盯市 mv=3e6）
        '20260103': [30, 5], // 暴跌
        '20260104': [5, 50], // 暴涨
        '20260105': [50, 8], // 出场日（盯市值无关，按 ret 收口）
      },
    });
    const res = runPortfolioSim(
      input({
        config: config([src], { cost: COST_PRESET_ZERO }),
        trades,
        quotes,
        calendar: ['20260102', '20260103', '20260104', '20260105'],
      }),
    );
    // 零成本 → realizedRetNet === ret，与盯市路径无关
    expect(res.fills[0].realizedRetNet).toBeCloseTo(ret, 12);
    // 出场日 NAV = 全部回到现金 = initialCapital*(1+ret)
    const lastNav = res.dailyRows[res.dailyRows.length - 1].nav;
    expect(lastNav).toBeCloseTo(1_000_000 * (1 + ret), 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 成本单调性
// ─────────────────────────────────────────────────────────────────────────────
describe('9. 成本单调性', () => {
  function finalNavWith(cost: PortfolioSimCostRates): number {
    // positionRatio<1：满仓 alloc==NAV 时任何正买费都会 cash_short（三档都不成交、退化为相等）。
    const src = source({ positionRatio: 0.5, rankField: 'none' });
    const trades = [trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260103', ret: 0.1 })];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 11] },
    });
    return runPortfolioSim(
      input({
        config: config([src], { cost }),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    ).summary.finalNav;
  }

  it('同输入三档成本：finalNav 逐档单调下降（乐观 > 现实 > 保守）', () => {
    const nOpt = finalNavWith(COST_PRESET_OPTIMISTIC);
    const nReal = finalNavWith(COST_PRESET_REALISTIC);
    const nCons = finalNavWith(COST_PRESET_CONSERVATIVE);
    expect(nOpt).toBeGreaterThan(nReal);
    expect(nReal).toBeGreaterThan(nCons);
  });

  it('零成本档：逐笔 realizedRetNet === ret', () => {
    const src = source({ positionRatio: 0.3, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260103', ret: 0.1 }),
      trade({ tsCode: 'Y', buyDate: '20260102', exitDate: '20260103', ret: -0.05 }),
    ];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 11] },
      Y: { '20260102': [10, 10], '20260103': [10, 9.5] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src], { cost: COST_PRESET_ZERO }),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    const byTs = new Map(res.fills.map((f) => [f.tsCode, f]));
    expect(byTs.get('X')!.realizedRetNet).toBeCloseTo(0.1, 12);
    expect(byTs.get('Y')!.realizedRetNet).toBeCloseTo(-0.05, 12);
    expect(res.summary.totalCosts).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 约束单调性（maxPositions 5→3→1）
// ─────────────────────────────────────────────────────────────────────────────
describe('10. 约束单调性', () => {
  it('maxPositions 5→3→1：taken 单调不增，且被弃信号 rank 不优于任何成交', () => {
    // 同日 6 候选，rank 各异（desc 优先大）。
    const trades: EngineTrade[] = [];
    const bars: Record<string, Record<string, [number, number]>> = {};
    const ranks = [9, 7, 5, 3, 1, 8];
    ranks.forEach((rk, i) => {
      const ts = `T${i}`;
      trades.push(
        trade({ tsCode: ts, buyDate: '20260102', exitDate: '20260120', rankValue: rk }),
      );
      bars[ts] = { '20260102': [10, 10] };
    });
    const quotes = buildQuotes(bars);

    function takenRanks(maxPositions: number): number[] {
      const src = source({
        positionRatio: 0.1,
        rankField: 'pos_120',
        rankDir: 'desc',
        maxPositions,
      });
      const res = runPortfolioSim(
        input({ config: config([src]), trades, quotes, calendar: ['20260102'] }),
      );
      return res.fills
        .filter((f) => f.status === 'taken')
        .map((f) => f.rankValue as number);
    }

    const t5 = takenRanks(5);
    const t3 = takenRanks(3);
    const t1 = takenRanks(1);
    // taken 单调不增
    expect(t5.length).toBe(5);
    expect(t3.length).toBe(3);
    expect(t1.length).toBe(1);
    // 被弃信号 rank 不优于任何成交：desc 下 taken 取 rank 最大的若干
    expect(new Set(t1)).toEqual(new Set([9]));
    expect(new Set(t3)).toEqual(new Set([9, 8, 7]));
    expect(new Set(t5)).toEqual(new Set([9, 8, 7, 5, 3]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 汇总指标手算小样本
// ─────────────────────────────────────────────────────────────────────────────
describe('11. 汇总指标手算', () => {
  it('maxDrawdown / annualRet / sharpe / dailyKelly 手算对数', () => {
    // 直接构造一个 NAV 序列：用单票 + 受控行情让 NAV = [1.0, 1.2, 0.9, 1.1] ×1e6。
    // 满仓单票、零成本、不出场（exitDate 在窗口外），NAV = mv = 1e6 * close/10。
    // close: 12, 9, 11, 11(=末日)；为得到 NAV 序列 1.2/0.9/1.1/1.1e6：
    const src = source({ positionRatio: 1, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260201', ret: 0 }),
    ];
    // 入场 20260102 open=10、close=12 → NAV=1.2e6
    // 20260103 close=9  → NAV=1.2e6*9/12=0.9e6
    // 20260104 close=11 → NAV=0.9e6*11/9=1.1e6
    // 20260105 close=11 → NAV=1.1e6*11/11=1.1e6
    const quotes = buildQuotes({
      X: {
        '20260102': [10, 12],
        '20260103': [12, 9],
        '20260104': [9, 11],
        '20260105': [11, 11],
      },
    });
    const calendar = ['20260102', '20260103', '20260104', '20260105'];
    const res = runPortfolioSim(
      input({ config: config([src], { cost: COST_PRESET_ZERO }), trades, quotes, calendar }),
    );
    const navs = res.dailyRows.map((r) => r.nav);
    expect(navs[0]).toBeCloseTo(1_200_000, 2);
    expect(navs[1]).toBeCloseTo(900_000, 2);
    expect(navs[2]).toBeCloseTo(1_100_000, 2);
    expect(navs[3]).toBeCloseTo(1_100_000, 2);

    // dailyRet 序列（首日分母 = initialCapital 1e6）：
    //   d0: 1.2/1.0 - 1 = 0.2
    //   d1: 0.9/1.2 - 1 = -0.25
    //   d2: 1.1/0.9 - 1 = 0.2222...
    //   d3: 1.1/1.1 - 1 = 0
    const rets = res.dailyRows.map((r) => r.dailyRet);
    expect(rets[0]).toBeCloseTo(0.2, 10);
    expect(rets[1]).toBeCloseTo(-0.25, 10);
    expect(rets[2]).toBeCloseTo(11 / 9 - 1, 10);
    expect(rets[3]).toBeCloseTo(0, 10);

    // totalRet = 1.1/1.0 - 1 = 0.1
    expect(res.summary.totalRet).toBeCloseTo(0.1, 10);

    // annualRet = (1.1)^(244/4) - 1
    const expectedAnnual = Math.pow(1.1, TRADING_DAYS_PER_YEAR / 4) - 1;
    expect(res.summary.annualRet).toBeCloseTo(expectedAnnual, 6);

    // maxDrawdown：峰值 1.2e6 → 谷 0.9e6 → dd = 0.9/1.2 - 1 = -0.25
    expect(res.summary.maxDrawdown).toBeCloseTo(-0.25, 10);

    // calmar = annualRet / 0.25
    expect(res.summary.calmar).toBeCloseTo((expectedAnnual as number) / 0.25, 6);

    // sharpe 手算：mean/std(n-1) × √244
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance =
      rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
    const std = Math.sqrt(variance);
    const expectedSharpe = (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    expect(res.summary.sharpe).toBeCloseTo(expectedSharpe, 6);

    // dailyKelly / dailyWinRate：dailyRet 序列喂 calcSignalStats（holdDays 全 1）。
    // 注意 calcSignalStats 的 winRate = wins / N（总样本，含 ret=0 那笔），N=4：
    //   wins=[0.2, 0.2222]（2 笔），losses=[-0.25]，ret=0 一笔不计入 wins/losses 但计入 N。
    //   winRate = 2/4 = 0.5
    expect(res.summary.dailyWinRate).toBeCloseTo(0.5, 10);
    // avgWin=(0.2+0.2222)/2, avgLoss=-0.25, b=avgWin/0.25, kelly=p-(1-p)/b，p=0.5
    const p = 0.5;
    const avgWin = (0.2 + (11 / 9 - 1)) / 2;
    const b = avgWin / 0.25;
    const expectedKelly = p - (1 - p) / b;
    expect(res.summary.dailyKelly).toBeCloseTo(expectedKelly, 10);
  });

  it('finalNav<=0 → annualRet / calmar 置 null', () => {
    // 构造亏到 NAV<=0：满仓单票 ret=-1.5（亏 150%，需杠杆才能为负；这里直接测公式分支）。
    // 用极端：positionRatio=1, ret=-2 → gross=1e6*(1-2)=-1e6, cash 收口后为负。
    const src = source({ positionRatio: 1, rankField: 'none' });
    const trades = [trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260103', ret: -2 })];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10], '20260103': [10, 10] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src], { cost: COST_PRESET_ZERO }),
        trades,
        quotes,
        calendar: ['20260102', '20260103'],
      }),
    );
    expect(res.summary.finalNav).toBeLessThanOrEqual(0);
    expect(res.summary.annualRet).toBeNull();
    expect(res.summary.calmar).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// anchorMode 恒等 + 约束停用
// ─────────────────────────────────────────────────────────────────────────────
describe('anchorMode 恒等性', () => {
  it('anchorMode：约束全停用（maxPositions/exposureCap/already_held/cash_short），每笔必 taken', () => {
    // positionRatio=0.6：3 笔 alloc 各 0.6e6（按 NAV_ref 算），合计 1.8e6 > 现金 1e6。
    //   anchorMode 旁路 cash_short（资金无限语义）→ 三笔仍全 taken、cash 允许变负。
    const src = source({
      positionRatio: 0.6,
      maxPositions: 1, // 应被忽略
      exposureCap: 0.1, // 应被忽略
    });
    // 同票两笔（非 anchor 会 already_held）+ 超 maxPositions + 超 exposureCap + 现金不足
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110', ret: 0.1 }),
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260110', ret: 0.1 }),
      trade({ tsCode: 'Y', buyDate: '20260102', exitDate: '20260110', ret: -0.2 }),
    ];
    const quotes = buildQuotes({
      X: { '20260102': [10, 10] },
      Y: { '20260102': [10, 10] },
    });
    const res = runPortfolioSim(
      input({
        config: config([src], { anchorMode: true }),
        trades,
        quotes,
        calendar: ['20260102'],
      }),
    );
    // 全部 taken（含 cash_short 旁路）
    expect(res.fills.every((f) => f.status === 'taken')).toBe(true);
    expect(res.summary.nTaken).toBe(3);
    // 现金耗尽后仍开仓 → 当日收盘现金为负（3 笔各 alloc 0.6e6、零成本，未出场）。
    expect(res.dailyRows[0].cash).toBeCloseTo(1_000_000 - 3 * 600_000, 4);
    expect(res.dailyRows[0].cash).toBeLessThan(0);
  });

  it('anchorMode：现金耗尽后信号仍全 taken、cash 可为负、每笔 realizedRetNet ≡ ret', () => {
    // 同日开仓且当日出场（round-trip）→ 收口回填 realizedRetNet，验证 ≡ ret。
    // positionRatio=0.6、3 笔同日 → 入场瞬间 cash 一度为负（资金无限语义），收口后回正。
    const src = source({ positionRatio: 0.6, rankField: 'none' });
    const rets = [0.1, -0.07, 0.25];
    const trades = rets.map((r, i) =>
      trade({
        tsCode: `T${i}`,
        buyDate: '20260102',
        exitDate: '20260103',
        ret: r,
      }),
    );
    const bars: Record<string, Record<string, [number, number]>> = {};
    for (let i = 0; i < rets.length; i++) {
      bars[`T${i}`] = { '20260102': [10, 13], '20260103': [13, 7] }; // 任意盯市路径
    }
    const res = runPortfolioSim(
      input({
        config: config([src], { anchorMode: true }),
        trades,
        quotes: buildQuotes(bars),
        calendar: ['20260102', '20260103'],
      }),
    );
    // 全部 taken（cash_short 旁路）
    expect(res.fills.every((f) => f.status === 'taken')).toBe(true);
    expect(res.summary.nTaken).toBe(3);
    // 入场日（20260102）现金为负：1e6 - 3*0.6e6 = -0.8e6（未出场）。
    expect(res.dailyRows[0].cash).toBeCloseTo(-800_000, 4);
    expect(res.dailyRows[0].cash).toBeLessThan(0);
    // 每笔 realizedRetNet ≡ ret（零成本恒等）。
    const byTs = new Map(res.fills.map((f) => [f.tsCode, f]));
    rets.forEach((r, i) => {
      expect(byTs.get(`T${i}`)!.realizedRetNet).toBeCloseTo(r, 12);
    });
    expect(res.summary.totalCosts).toBe(0);
  });

  it('回归：单日候选数 × positionRatio 远超 1（5 信号 × 0.5）anchorMode 全 taken', () => {
    // 直击本缺陷：源 run 单日峰值大量信号、positionRatio 偏大时，
    //   非 anchorMode 现金早早耗尽会大批 cash_short；anchorMode 必须每笔成交（对账要求全成交）。
    const src = source({ positionRatio: 0.5, rankField: 'none' });
    const trades: EngineTrade[] = [];
    const bars: Record<string, Record<string, [number, number]>> = {};
    for (let i = 0; i < 5; i++) {
      const ts = `T${i}`;
      trades.push(trade({ tsCode: ts, buyDate: '20260102', exitDate: '20260110' }));
      bars[ts] = { '20260102': [10, 10] };
    }
    const res = runPortfolioSim(
      input({
        config: config([src], { anchorMode: true }),
        trades,
        quotes: buildQuotes(bars),
        calendar: ['20260102'],
      }),
    );
    // 5 笔 × 0.5 = 2.5 倍资金需求，但 anchorMode 旁路 cash_short → 5 笔全 taken。
    expect(res.fills.filter((f) => f.status === 'taken').length).toBe(5);
    expect(res.fills.some((f) => f.skipReason === 'cash_short')).toBe(false);
    // 现金 = 1e6 - 5*0.5e6 = -1.5e6（深度为负，证明 cash_short 确被旁路）。
    expect(res.dailyRows[0].cash).toBeCloseTo(-1_500_000, 4);
  });

  it('anchorMode：realizedRetNet ≡ ret（代数恒等，多笔不同 ret）', () => {
    const src = source({ positionRatio: 0.2 });
    const rets = [0.13, -0.07, 0.25, -0.3];
    const trades = rets.map((r, i) =>
      trade({
        tsCode: `T${i}`,
        buyDate: '20260102',
        exitDate: '20260103',
        ret: r,
      }),
    );
    const bars: Record<string, Record<string, [number, number]>> = {};
    for (let i = 0; i < rets.length; i++) {
      bars[`T${i}`] = { '20260102': [10, 13], '20260103': [13, 7] }; // 任意盯市路径
    }
    const res = runPortfolioSim(
      input({
        config: config([src], { anchorMode: true }),
        trades,
        quotes: buildQuotes(bars),
        calendar: ['20260102', '20260103'],
      }),
    );
    const byTs = new Map(res.fills.map((f) => [f.tsCode, f]));
    rets.forEach((r, i) => {
      expect(byTs.get(`T${i}`)!.realizedRetNet).toBeCloseTo(r, 12);
    });
    expect(res.summary.totalCosts).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 多策略：strategyExposure / source 顺序处理
// ─────────────────────────────────────────────────────────────────────────────
describe('多策略组合', () => {
  it('两策略各自约束独立，strategyExposure 按 label 拆分', () => {
    const srcA = source({ label: 'A', positionRatio: 0.2, rankField: 'none' });
    const srcB = source({ runId: 'run-b', label: 'B', positionRatio: 0.1, rankField: 'none' });
    const trades = [
      trade({ sourceIdx: 0, tsCode: 'A1', buyDate: '20260102', exitDate: '20260120' }),
      trade({ sourceIdx: 1, tsCode: 'B1', buyDate: '20260102', exitDate: '20260120' }),
    ];
    const quotes = buildQuotes({
      A1: { '20260102': [10, 10] },
      B1: { '20260102': [10, 10] },
    });
    const res = runPortfolioSim(
      input({
        config: config([srcA, srcB]),
        trades,
        quotes,
        calendar: ['20260102'],
      }),
    );
    const row = res.dailyRows[0];
    // mv 恒 = alloc（同价）：A=0.2e6, B=0.1e6, NAV=1e6
    expect(row.strategyExposure['A']).toBeCloseTo(0.2, 10);
    expect(row.strategyExposure['B']).toBeCloseTo(0.1, 10);
    expect(row.exposure).toBeCloseTo(0.3, 10);
    expect(row.positionCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 同一日 round-trip（exitDate == buyDate）
// ─────────────────────────────────────────────────────────────────────────────
describe('同一日 round-trip', () => {
  it('exitDate == buyDate：开仓后立即收口，不参与盯市', () => {
    const src = source({ positionRatio: 0.5, rankField: 'none' });
    const trades = [
      trade({ tsCode: 'X', buyDate: '20260102', exitDate: '20260102', ret: 0.1 }),
    ];
    const quotes = buildQuotes({
      X: { '20260102': [10, 99] }, // close 99 无关（不参与盯市）
    });
    const res = runPortfolioSim(
      input({
        config: config([src], { anchorMode: true }),
        trades,
        quotes,
        calendar: ['20260102'],
      }),
    );
    expect(res.fills[0].status).toBe('taken');
    expect(res.fills[0].realizedRetNet).toBeCloseTo(0.1, 12);
    // 收口后不在仓
    expect(res.dailyRows[0].positionCount).toBe(0);
    // NAV = 全现金 = 0.5e6 留存 + 0.5e6*(1.1) 回款 = 1.05e6
    expect(res.dailyRows[0].nav).toBeCloseTo(1_050_000, 4);
  });
});
