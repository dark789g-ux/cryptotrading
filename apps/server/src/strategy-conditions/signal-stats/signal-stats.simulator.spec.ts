/**
 * signal-stats.simulator.spec.ts
 *
 * 逐笔出场模拟纯函数单测，覆盖 spec 05 §5.2 列举的用例：
 *   fixed_n 口径、持有期停牌 hold_days 不递增、strategy 首次命中出场、
 *   满 max_hold 强平、退市强平、一字涨停剔除、次新剔除、停牌剔除、insufficient_data 边界。
 *
 * 全部用构造的「持有窗口数据序列」(HoldingDaySnapshot[]) 驱动，不连 DB。
 * 口径基准：docs/.../02-simulation-and-semantics.md（含持有期计数与边界口径裁决 Q1~Q5）。
 */

import {
  simulateTradeCore,
  decideFixedN,
  decideStrategy,
  findLastIndexLE,
  buildHoldingDays,
  HoldingDaySnapshot,
  SimulationInput,
  WindowQuote,
  NEW_LISTING_MIN_TRADING_DAYS,
} from './signal-stats.simulator';

// ─────────────────────────────────────────────────────────────────────────────
// 构造辅助：一个「正常可交易日」快照（hasQuote=true）。
// 用价格序列驱动：qfqOpen/qfqClose 自定，rawOpen 默认远低于 upLimit（不触发涨停）。
// ─────────────────────────────────────────────────────────────────────────────
function tradingDay(
  calDate: string,
  opts: Partial<HoldingDaySnapshot> = {},
): HoldingDaySnapshot {
  return {
    calDate,
    hasQuote: true,
    qfqOpen: opts.qfqOpen ?? 10,
    qfqClose: opts.qfqClose ?? 10,
    qfqHigh: opts.qfqHigh ?? null,
    qfqLow: opts.qfqLow ?? null,
    rawOpen: opts.rawOpen ?? 10,
    rawHigh: opts.rawHigh ?? null,
    upLimit: opts.upLimit ?? 11, // rawOpen(10) < upLimit(11)：默认不涨停
    downLimit: opts.downLimit ?? null,
    ma5: opts.ma5 ?? null,
    exitSignalHit: opts.exitSignalHit ?? false,
    ...opts,
  };
}

/** 停牌日：daily_quote 无行 → hasQuote=false，所有价为 null。 */
function suspendedDay(calDate: string): HoldingDaySnapshot {
  return {
    calDate,
    hasQuote: false,
    qfqOpen: null,
    qfqClose: null,
    qfqHigh: null,
    qfqLow: null,
    rawOpen: null,
    rawHigh: null,
    upLimit: null,
    downLimit: null,
    ma5: null,
    exitSignalHit: false,
  };
}

/** 基础有效输入工厂：daysSinceList 给足（不触发次新）、未退市。 */
function baseInput(
  days: HoldingDaySnapshot[],
  exit: SimulationInput['exit'],
  overrides: Partial<SimulationInput> = {},
): SimulationInput {
  return {
    tsCode: '000001.SZ',
    signalDate: '20260101',
    days,
    daysSinceList: 999, // 远超 60，不触发次新
    delistDate: null,
    exit,
    ...overrides,
  };
}

describe('simulateTradeCore', () => {
  // ───────────────────────────────────────────────
  // fixed_n 口径：T+1 开盘买、第 N 个可交易日收盘卖
  // ───────────────────────────────────────────────
  describe('fixed_n 基本口径', () => {
    it('N=1：买 days[0] qfqOpen，卖 days[1] qfqClose，ret 正确，holdDays=1', () => {
      // buy_date=days[0] qfqOpen=10；第 1 个持有交易日=days[1] qfqClose=11
      // ret = 11/10 - 1 = 0.1
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.buyDate).toBe('20260102');
      expect(out.trade.exitDate).toBe('20260103');
      expect(out.trade.buyPrice).toBe(10);
      expect(out.trade.exitPrice).toBe(11);
      expect(out.trade.ret).toBeCloseTo(0.1, 10);
      expect(out.trade.holdDays).toBe(1);
      expect(out.trade.exitReason).toBe('max_hold');
    });

    it('N=3：跨 3 个可交易日，holdDays 恒=N=3', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103'),
        tradingDay('20260106'),
        tradingDay('20260107', { qfqClose: 12 }),
        tradingDay('20260108'), // 多余的窗口日，不应被用到
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 3 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260107');
      expect(out.trade.exitPrice).toBe(12);
      expect(out.trade.ret).toBeCloseTo(12 / 10 - 1, 10);
      expect(out.trade.holdDays).toBe(3);
    });
  });

  // ───────────────────────────────────────────────
  // 持有期停牌：hold_days 不递增、不占 N 额度、顺延取价
  // ───────────────────────────────────────────────
  describe('持有期停牌顺延（Q1）', () => {
    it('fixed_n N=2：中途停牌日不占额度，顺延到下一可交易日', () => {
      // days: [buy, 停牌, 可交易, 可交易]
      // 第 1 个可交易持有日 = days[2]，第 2 个 = days[3]（出场）
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        suspendedDay('20260103'), // 停牌：跳过
        tradingDay('20260106'), // 第 1 个可交易日
        tradingDay('20260107', { qfqClose: 13 }), // 第 2 个 → 出场
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 2 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260107');
      expect(out.trade.exitPrice).toBe(13);
      // holdDays = 已走过的「可交易日」数 = 2（停牌日不递增；fixed_n 恒 == N）
      expect(out.trade.holdDays).toBe(2);
    });
  });

  // ───────────────────────────────────────────────
  // strategy：首次命中卖出条件出场
  // ───────────────────────────────────────────────
  describe('strategy 首次命中（signal）', () => {
    it('buy_date 当天不判，从下一交易日起；首次 exitSignalHit 日出场', () => {
      // buy_date=days[0]（即便构造 exitSignalHit=true 也不判）；days[2] 首次命中
      const days = [
        tradingDay('20260102', { qfqOpen: 10, exitSignalHit: true }), // 当天不判
        tradingDay('20260103', { exitSignalHit: false }),
        tradingDay('20260106', { qfqClose: 14, exitSignalHit: true }), // 首次命中 → 出场
        tradingDay('20260107', { exitSignalHit: true }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 10 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260106');
      expect(out.trade.exitPrice).toBe(14);
      expect(out.trade.exitReason).toBe('signal');
      expect(out.trade.holdDays).toBe(2);
    });

    it('最短持有 1 交易日：days[1] 即命中', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11, exitSignalHit: true }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 5 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.holdDays).toBe(1);
      expect(out.trade.exitReason).toBe('signal');
    });
  });

  // ───────────────────────────────────────────────
  // strategy：满 max_hold 仍未命中 → 强平 max_hold
  // ───────────────────────────────────────────────
  describe('strategy 满 max_hold 强平', () => {
    it('max_hold=2 全程未命中：第 2 个可交易日 qfq_close 强平 max_hold', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { exitSignalHit: false }),
        tradingDay('20260106', { qfqClose: 9, exitSignalHit: false }), // 第 2 个可交易日 → 强平
        tradingDay('20260107', { exitSignalHit: false }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 2 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260106');
      expect(out.trade.exitPrice).toBe(9);
      expect(out.trade.exitReason).toBe('max_hold');
      expect(out.trade.ret).toBeCloseTo(9 / 10 - 1, 10);
      expect(out.trade.holdDays).toBe(2);
    });

    it('strategy 持有期停牌不占 max_hold 额度', () => {
      // max_hold=2；中间停牌日不计，强平落在第 2 个可交易日
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        suspendedDay('20260103'),
        tradingDay('20260106', { exitSignalHit: false }), // 第 1 个可交易日
        tradingDay('20260107', { qfqClose: 8, exitSignalHit: false }), // 第 2 个 → 强平
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 2 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260107');
      expect(out.trade.exitReason).toBe('max_hold');
      expect(out.trade.holdDays).toBe(2); // 可交易日数（停牌日不递增；== maxHold）
    });
  });

  // ───────────────────────────────────────────────
  // 退市强平（Q4）
  // ───────────────────────────────────────────────
  describe('退市强平', () => {
    it('持有推进中 cal_date >= delistDate：用之前最后一个有 quote 日 qfq_close 强平 delist', () => {
      // delistDate=20260107；days[3] cal_date=20260107 >= delistDate → 用之前最后有 quote 日强平
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103'),
        tradingDay('20260106', { qfqClose: 15 }), // 最后一个有 quote 日
        tradingDay('20260107'), // cal_date >= delistDate → 退市触发
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 10 }, { delistDate: '20260107' }),
      );
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260106');
      expect(out.trade.exitPrice).toBe(15);
      expect(out.trade.exitReason).toBe('delist');
      expect(out.trade.holdDays).toBe(2);
    });

    it('delistDate=null：永不触发退市，正常走 fixed_n', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { delistDate: null }),
      );
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitReason).toBe('max_hold');
    });

    it('退市在停牌日之后触发：仍用退市前最后有 quote 日强平', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 12 }), // 最后有 quote 日
        suspendedDay('20260106'), // 停牌
        tradingDay('20260107'), // cal_date >= delist → 退市，但用 days[1] 强平
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'strategy', maxHold: 10 }, { delistDate: '20260107' }),
      );
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260103');
      expect(out.trade.exitPrice).toBe(12);
      expect(out.trade.exitReason).toBe('delist');
    });
  });

  // ───────────────────────────────────────────────
  // 入场过滤：停牌 / 一字涨停 / 次新
  // ───────────────────────────────────────────────
  describe('入场过滤', () => {
    it('停牌剔除：buy_date 无 quote → suspended', () => {
      const days = [suspendedDay('20260102'), tradingDay('20260103')];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('suspended');
    });

    it('停牌剔除：buy_date 有行但 qfq_open 空 → suspended', () => {
      const buy = tradingDay('20260102', { qfqOpen: null }); // hasQuote 仍 true 但价空
      // 模拟 DB 层会把 qfq_open 空判为 hasQuote=false；此处直接构造 qfqOpen=null 验纯函数兜底
      const days = [buy, tradingDay('20260103')];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('suspended');
    });

    it('一字涨停剔除：rawOpen >= upLimit → limit_up（计价用 qfqOpen 但判定用未复权）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, rawOpen: 11, upLimit: 11 }), // 开盘顶格
        tradingDay('20260103'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('limit_up');
    });

    it('一字涨停边界：rawOpen 恰等于 upLimit 即剔除', () => {
      const days = [
        tradingDay('20260102', { rawOpen: 9.99, upLimit: 9.99 }),
        tradingDay('20260103'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind === 'filtered') expect(out.reason).toBe('limit_up');
    });

    it('未涨停：rawOpen < upLimit 不剔除', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, rawOpen: 10.5, upLimit: 11, qfqClose: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
    });

    it('upLimit 缺失：不触发涨停过滤', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, rawOpen: 99, upLimit: null }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
    });

    it('次新剔除：daysSinceList < 60 → new_listing', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { daysSinceList: 59 }),
      );
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('new_listing');
    });

    it('次新边界：daysSinceList=60 恰好不剔除（< 60 才剔）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, {
          daysSinceList: NEW_LISTING_MIN_TRADING_DAYS,
        }),
      );
      expect(out.kind).toBe('trade');
    });

    it('list_date 缺失（daysSinceList=null）：不按次新剔除', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { daysSinceList: null }),
      );
      expect(out.kind).toBe('trade');
    });

    it('过滤优先级：停牌先于涨停（buy_date 既无 quote 又看似涨停 → suspended）', () => {
      // 停牌日所有价 null，先被停牌拦截
      const days = [suspendedDay('20260102'), tradingDay('20260103')];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { daysSinceList: 1 }),
      );
      expect(out.kind).toBe('filtered');
      if (out.kind === 'filtered') expect(out.reason).toBe('suspended');
    });
  });

  // ───────────────────────────────────────────────
  // insufficient_data 边界（Q5）
  // ───────────────────────────────────────────────
  describe('insufficient_data 边界', () => {
    it('空窗口（buy_date 越界/未收录）→ insufficient_data', () => {
      const out = simulateTradeCore(baseInput([], { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });

    it('fixed_n 窗口不足凑满 N 且未退市 → insufficient_data', () => {
      // 只有 buy_date 一天，凑不出第 1 个持有交易日
      const days = [tradingDay('20260102', { qfqOpen: 10 })];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });

    it('fixed_n 窗口全是停牌日（无可交易出场日）→ insufficient_data', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        suspendedDay('20260103'),
        suspendedDay('20260106'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });

    it('strategy 窗口不足凑满 max_hold 且未命中未退市 → insufficient_data', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { exitSignalHit: false }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 5 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });
  });

  // ───────────────────────────────────────────────
  // 前向收益 ret 口径
  // ───────────────────────────────────────────────
  describe('前向收益 ret', () => {
    it('ret = qfq_close[exit]/qfq_open[buy] - 1（负收益）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 20 }),
        tradingDay('20260103', { qfqClose: 18 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.ret).toBeCloseTo(18 / 20 - 1, 10); // -0.1
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideFixedN / decideStrategy 直接覆盖（出场决策子函数）
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// findLastIndexLE（次新 list_date 索引兜底）
// ─────────────────────────────────────────────────────────────────────────────
describe('findLastIndexLE', () => {
  const cal = ['20260102', '20260103', '20260106', '20260107'];
  it('精确命中', () => expect(findLastIndexLE(cal, '20260106')).toBe(2));
  it('落在间隙取前一个', () => expect(findLastIndexLE(cal, '20260105')).toBe(1));
  it('早于全部 → -1', () => expect(findLastIndexLE(cal, '20260101')).toBe(-1));
  it('晚于全部 → 末位', () => expect(findLastIndexLE(cal, '20261231')).toBe(3));
});

// ─────────────────────────────────────────────────────────────────────────────
// buildHoldingDays（持有窗口构造共享纯函数）
// ─────────────────────────────────────────────────────────────────────────────
describe('buildHoldingDays', () => {
  /** 构造辅助：完整 WindowQuote 行（正常可交易日）。 */
  function makeQuote(
    qfqOpen: number | null,
    qfqClose: number | null,
    open: number | null = qfqOpen,
  ): WindowQuote {
    return { qfqOpen, qfqClose, open };
  }

  it('正常日：quoteMap 有行 → hasQuote=true，各字段正确映射', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(10, 11, 9.8)]]);
    const limitMap = new Map([['20260102', 12 as number | null]]);
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result).toHaveLength(1);
    const day = result[0];
    expect(day.calDate).toBe('20260102');
    expect(day.hasQuote).toBe(true);
    expect(day.qfqOpen).toBe(10);
    expect(day.qfqClose).toBe(11);
    expect(day.rawOpen).toBe(9.8);
    expect(day.upLimit).toBe(12);
    expect(day.exitSignalHit).toBe(false); // idx=0，即便在 hitSet 里也 false
  });

  it('停牌日：quoteMap 无该 key → hasQuote=false，价格字段全 null', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map<string, WindowQuote>(); // 无该日 key
    const limitMap = new Map([['20260102', 11 as number | null]]);
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    const day = result[0];
    expect(day.hasQuote).toBe(false);
    expect(day.qfqOpen).toBeNull();
    expect(day.qfqClose).toBeNull();
    expect(day.rawOpen).toBeNull();
    expect(day.upLimit).toBe(11); // limitMap 仍有 key，upLimit 非 null
  });

  it('qfqOpen 为 null → hasQuote=false（!!q && qfqOpen!==null && qfqClose!==null）', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(null, 10)]]);
    const limitMap = new Map<string, number | null>();
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].hasQuote).toBe(false);
    expect(result[0].qfqOpen).toBeNull();
    expect(result[0].qfqClose).toBe(10); // qfqClose 按 ?? null 取原值
  });

  it('qfqClose 为 null → hasQuote=false', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(10, null)]]);
    const limitMap = new Map<string, number | null>();
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].hasQuote).toBe(false);
    expect(result[0].qfqOpen).toBe(10);
    expect(result[0].qfqClose).toBeNull();
  });

  it('limitMap 缺 key → upLimit null', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(10, 10)]]);
    const limitMap = new Map<string, number | null>(); // 无该 key
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].upLimit).toBeNull();
  });

  it('exitSignalHit idx>0 语义：hitSet 同时包含 days[0] 与 days[2]，days[0].exitSignalHit===false，days[2].exitSignalHit===true', () => {
    // 这是 zero-drift 防回归关键用例：buyDate 在 hitSet 里也必须被排除
    const windowDates = ['20260102', '20260103', '20260106'];
    const quoteMap = new Map<string, WindowQuote>([
      ['20260102', makeQuote(10, 10)],
      ['20260103', makeQuote(10, 10)],
      ['20260106', makeQuote(10, 10)],
    ]);
    const limitMap = new Map<string, number | null>();
    // hitSet 同时包含 windowDates[0]（buyDate）和 windowDates[2]
    const hitSet = new Set(['20260102', '20260106']);

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].exitSignalHit).toBe(false); // idx=0：buyDate 必须排除，即便在 hitSet 里
    expect(result[1].exitSignalHit).toBe(false); // 不在 hitSet
    expect(result[2].exitSignalHit).toBe(true);  // idx=2 且在 hitSet
  });

  it('空 windowDates → 返回空数组', () => {
    const result = buildHoldingDays(
      [],
      new Map<string, WindowQuote>(),
      new Map<string, number | null>(),
      new Set<string>(),
    );
    expect(result).toHaveLength(0);
  });

  it('多日混合：正常日、停牌日、exitSignalHit 综合验证', () => {
    const windowDates = ['20260102', '20260103', '20260106', '20260107'];
    const quoteMap = new Map<string, WindowQuote>([
      ['20260102', makeQuote(10, 10)],
      // 20260103 停牌（无 key）
      ['20260106', makeQuote(11, 12)],
      ['20260107', makeQuote(12, 13)],
    ]);
    const limitMap = new Map<string, number | null>([
      ['20260102', 11],
      ['20260106', 13],
      // 20260107 limitMap 无 key → null
    ]);
    const hitSet = new Set(['20260102', '20260107']); // buyDate + 最后一天

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result).toHaveLength(4);

    // days[0]：正常日，buyDate → exitSignalHit 排除
    expect(result[0].hasQuote).toBe(true);
    expect(result[0].upLimit).toBe(11);
    expect(result[0].exitSignalHit).toBe(false); // idx=0，排除

    // days[1]：停牌日
    expect(result[1].hasQuote).toBe(false);
    expect(result[1].qfqOpen).toBeNull();
    expect(result[1].upLimit).toBeNull(); // limitMap 无 20260103

    // days[2]：正常日，不在 hitSet
    expect(result[2].hasQuote).toBe(true);
    expect(result[2].qfqOpen).toBe(11);
    expect(result[2].qfqClose).toBe(12);
    expect(result[2].exitSignalHit).toBe(false);

    // days[3]：正常日，在 hitSet，idx=3 > 0
    expect(result[3].hasQuote).toBe(true);
    expect(result[3].upLimit).toBeNull(); // limitMap 无 20260107
    expect(result[3].exitSignalHit).toBe(true);
  });
});
