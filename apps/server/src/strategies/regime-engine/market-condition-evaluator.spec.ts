/**
 * market-condition-evaluator.spec.ts
 *
 * 大盘/个股分桶条件求值器单测（v3 snapshot 结构）。
 */
import {
  evaluateMarketConditions,
  MarketSnapshot,
  MARKET_CONDITION_FIELD_WHITELIST,
  IndexTargetSnapshot,
  StockTargetSnapshot,
  TargetSnapshot,
} from './market-condition-evaluator';
import { RegimeBucketCondition, MatchGroup, MatchNode, isMatchGroup, collectMatchTargets } from '../../entities/strategy/regime-strategy-config.entity';

const INDEX_TARGET = '000001.SH';
const STOCK_TARGET = '000001.SZ';

function makeIndexTarget(): IndexTargetSnapshot {
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
      dif: 10,
      dea: 5,
      macd: 10,
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

function makeStockTarget(): StockTargetSnapshot {
  return {
    quote: {
      open: 10,
      high: 11,
      low: 9.5,
      close: 10.5,
      volume: 1_000_000,
      amount: 10_000_000,
      pct_chg: 0.05,
    },
    indicator: {
      macd_dif: 0.5,
      macd_dea: 0.2,
      macd_hist: 0.3,
      kdj_j: 80,
      kdj_k: 60,
      kdj_d: 50,
      bbi: 10.2,
      ma5: 10.1,
      ma30: 10,
      ma60: 9.8,
      ma120: 9.5,
      ma240: 9,
      atr14: 0.5,
      profit_loss_ratio: 2,
      roc10: 0.02,
      roc20: 0.03,
      roc60: 0.05,
      brick: 1,
      brick_delta: 0.1,
      brick_xg: true,
      amv_dif: 0.4,
      amv_dea: 0.1,
      amv_macd: 0.3,
      pos_120: 0.8,
      pos_60: 0.7,
      close_ma60_ratio: 0.07,
      vol_ratio_60: 1.2,
      vol_ratio_120: 1.1,
    },
    basic: {
      turnover_rate: 1,
      volume_ratio: 1.2,
      pe: 10,
      pe_ttm: 9,
      pb: 1.5,
      total_mv: 1_000_000_000,
      circ_mv: 500_000_000,
    },
  };
}

function makeSnapshot(
  targets?: Map<string, TargetSnapshot>,
  prevTargets?: Map<string, TargetSnapshot>,
  date = '20260610',
  prevDate?: string,
): MarketSnapshot {
  return {
    date,
    targets: targets ?? new Map(),
    ...(prevDate ? { prevDate, prevTargets } : {}),
  };
}

function cond(
  type: 'index' | 'stock',
  target: string,
  field: string,
  operator: string,
  value?: number,
  compareField?: string,
  compareMode?: 'value' | 'field',
): RegimeBucketCondition {
  const c: RegimeBucketCondition = { type, target, field, operator };
  if (value !== undefined) c.value = value;
  if (compareField !== undefined) c.compareField = compareField;
  if (compareMode !== undefined) c.compareMode = compareMode;
  return c;
}

describe('evaluateMarketConditions', () => {
  it('空条件数组 fail-closed', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [])).toBe(false);
  });

  it('指数常量比较命中', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'close', 'gt', 3000)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'ma60', 'lt', 3000)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'macd', 'eq', 10)])).toBe(true);
  });

  it('指数常量比较不命中', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'close', 'lt', 3000)])).toBe(false);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'macd', 'lte', 0)])).toBe(false);
  });

  it('个股常量比较命中', () => {
    const s = makeSnapshot(new Map([[STOCK_TARGET, makeStockTarget()]]));
    expect(evaluateMarketConditions(s, [cond('stock', STOCK_TARGET, 'close', 'gt', 10)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('stock', STOCK_TARGET, 'macd_hist', 'gt', 0)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('stock', STOCK_TARGET, 'amv_dif', 'gt', 0)])).toBe(true);
  });

  it('个股常量比较不命中', () => {
    const s = makeSnapshot(new Map([[STOCK_TARGET, makeStockTarget()]]));
    expect(evaluateMarketConditions(s, [cond('stock', STOCK_TARGET, 'close', 'lt', 10)])).toBe(false);
    expect(evaluateMarketConditions(s, [cond('stock', STOCK_TARGET, 'macd_hist', 'lte', 0)])).toBe(false);
  });

  it('目标缺失 fail-closed', () => {
    const s = makeSnapshot(new Map());
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'close', 'gt', 0)])).toBe(false);
    expect(evaluateMarketConditions(s, [cond('stock', STOCK_TARGET, 'close', 'gt', 0)])).toBe(false);
  });

  it('字段缺失 / 未知字段 fail-closed', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(
      evaluateMarketConditions(s, [
        { type: 'index', target: INDEX_TARGET, field: '', operator: 'gt', value: 0 } as any,
      ]),
    ).toBe(false);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'unknown_field', 'gt', 0)])).toBe(false);
  });

  it('compareMode=value 常量比较', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'gt', 0)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'lt', 0)])).toBe(false);
  });

  it('compareMode=field 同目标字段比较', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(
      evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'close', 'gt', undefined, 'ma60', 'field')]),
    ).toBe(true);
    expect(
      evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'close', 'lt', undefined, 'ma60', 'field')]),
    ).toBe(false);
  });

  it('compareMode=field 跨类型不命中白名单 fail-closed', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // 个股字段不能作为指数条件 compareField
    expect(
      evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'close', 'gt', undefined, 'macd_hist', 'field')]),
    ).toBe(false);
  });

  it('cross_above 命中与未命中', () => {
    const prev = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 4, dea: 5 } }],
    ]);
    const curr = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 6, dea: 5 } }],
    ]);
    const s = makeSnapshot(curr, prev, '20260610', '20260609');

    // dif 从 4 升到 6，dea 维持 5：cross_above
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'cross_above', undefined, 'dea', 'field')])).toBe(true);

    // 未交叉：prev dif 已在 dea 之上
    const noCrossPrev = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 6, dea: 5 } }],
    ]);
    const noCross = makeSnapshot(curr, noCrossPrev, '20260610', '20260609');
    expect(evaluateMarketConditions(noCross, [cond('index', INDEX_TARGET, 'dif', 'cross_above', undefined, 'dea', 'field')])).toBe(false);
  });

  it('cross_below 命中', () => {
    const prev = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 6, dea: 5 } }],
    ]);
    const curr = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 4, dea: 5 } }],
    ]);
    const s = makeSnapshot(curr, prev, '20260610', '20260609');
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'cross_below', undefined, 'dea', 'field')])).toBe(true);
  });

  it('cross 操作缺少 prevTargets fail-closed', () => {
    const curr = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 6, dea: 5 } }],
    ]);
    const s = makeSnapshot(curr);
    expect(
      evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'cross_above', undefined, 'dea', 'field')]),
    ).toBe(false);
  });

  it('cross 操作缺少 prevLeft / prevRight fail-closed', () => {
    const prev = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: null, dea: 5 } }],
    ]);
    const curr = new Map([
      [INDEX_TARGET, { ...makeIndexTarget(), indicator: { ...makeIndexTarget().indicator, dif: 6, dea: 5 } }],
    ]);
    const s = makeSnapshot(curr, prev, '20260610', '20260609');
    expect(
      evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'cross_above', undefined, 'dea', 'field')]),
    ).toBe(false);
  });

  it('多条件 AND 语义', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'gt', 0),
        cond('index', INDEX_TARGET, 'dif', 'gt', 0),
      ]),
    ).toBe(true);
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'lt', 0),
      ]),
    ).toBe(false);
  });

  it('matchLogic=or 时任一条件满足即命中', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // close > 3000 true, macd < 0 false → OR → true
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'lt', 0),
      ], 'or'),
    ).toBe(true);
    // dif < 0 false, close > 3000 true → OR → true
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'dif', 'lt', 0),
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
      ], 'or'),
    ).toBe(true);
  });

  it('matchLogic=or 时全部不满足则不命中', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // close < 0 false, dif < 0 false → OR → false
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'lt', 0),
        cond('index', INDEX_TARGET, 'dif', 'lt', 0),
      ], 'or'),
    ).toBe(false);
  });

  it('matchLogic 默认(and) 行为不变', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // 不传 logic → 默认 and: close > 3000 true, macd < 0 false → false
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'lt', 0),
      ]),
    ).toBe(false);
    // 显式传 'and' → 同上
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'lt', 0),
      ], 'and'),
    ).toBe(false);
    // 全满足 → true
    expect(
      evaluateMarketConditions(s, [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'dif', 'gt', 0),
      ], 'and'),
    ).toBe(true);
  });

  it('非法 value fail-closed', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'gt', NaN)])).toBe(false);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'gt', Infinity)])).toBe(false);
  });

  it('字段值为 null 时 fail-closed', () => {
    const target = makeIndexTarget();
    target.indicator.macd = null;
    const s = makeSnapshot(new Map([[INDEX_TARGET, target]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'macd', 'gt', 0)])).toBe(false);
  });

  it('boolean 字段按 1/0 比较', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'brick_xg', 'eq', 1)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'brick_xg', 'eq', 0)])).toBe(false);
  });

  it('neq 操作符', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'neq', 0)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('index', INDEX_TARGET, 'dif', 'neq', 10)])).toBe(false);
  });
});

function matchGroup(logic: 'and' | 'or', items: MatchNode[]): MatchGroup {
  return { logic, items };
}

describe('evaluateMarketConditions — 嵌套 MatchGroup', () => {
  it('(A∧B)∨(C∧D) — 两组全真 → true', () => {
    // A: close > 3000 (true), B: macd > 0 (true)
    // C: dif > 0 (true), D: dea > 0 (true)
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    const conditions: MatchNode[] = [
      matchGroup('or', [
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'close', 'gt', 3000),
          cond('index', INDEX_TARGET, 'macd', 'gt', 0),
        ]),
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'dif', 'gt', 0),
          cond('index', INDEX_TARGET, 'dea', 'gt', 0),
        ]),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(true);
  });

  it('(A∧B)∨(C∧D) — 第一组 A 假 B 真，第二组 C 真 D 真 → true', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    const conditions: MatchNode[] = [
      matchGroup('or', [
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'close', 'lt', 0),   // false
          cond('index', INDEX_TARGET, 'macd', 'gt', 0),    // true
        ]),
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'dif', 'gt', 0),    // true
          cond('index', INDEX_TARGET, 'dea', 'gt', 0),    // true
        ]),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(true);
  });

  it('(A∧B)∨(C∧D) — 两组全假 → false', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    const conditions: MatchNode[] = [
      matchGroup('or', [
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'close', 'lt', 0),   // false
          cond('index', INDEX_TARGET, 'macd', 'lt', 0),    // false (macd=10)
        ]),
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'dif', 'lt', 0),    // false (dif=10)
          cond('index', INDEX_TARGET, 'dea', 'lt', 0),    // false (dea=5)
        ]),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(false);
  });

  it('(A∧B)∧(C∨D) — 混合嵌套，多种组合', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // A: close>3000 (true), B: macd>0 (true), C: dif<0 (false), D: dea<0 (false)
    // (true ∧ true) ∧ (false ∨ false) → false
    const falseCase: MatchNode[] = [
      matchGroup('and', [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'gt', 0),
        matchGroup('or', [
          cond('index', INDEX_TARGET, 'dif', 'lt', 0),
          cond('index', INDEX_TARGET, 'dea', 'lt', 0),
        ]),
      ]),
    ];
    expect(evaluateMarketConditions(s, falseCase)).toBe(false);

    // A: close>3000 (true), B: macd>0 (true), C: dif>0 (true), D: dea<0 (false)
    // (true ∧ true) ∧ (true ∨ false) → true
    const trueCase: MatchNode[] = [
      matchGroup('and', [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'macd', 'gt', 0),
        matchGroup('or', [
          cond('index', INDEX_TARGET, 'dif', 'gt', 0),
          cond('index', INDEX_TARGET, 'dea', 'lt', 0),
        ]),
      ]),
    ];
    expect(evaluateMarketConditions(s, trueCase)).toBe(true);
  });

  it('三层嵌套 A ∨ (B ∧ (C ∨ D))', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // A: close<0 (false), B: macd>0 (true), C: dif>0 (true), D: dea<0 (false)
    // false ∨ (true ∧ (true ∨ false)) → false ∨ (true ∧ true) → true
    const conditions: MatchNode[] = [
      matchGroup('or', [
        cond('index', INDEX_TARGET, 'close', 'lt', 0),
        matchGroup('and', [
          cond('index', INDEX_TARGET, 'macd', 'gt', 0),
          matchGroup('or', [
            cond('index', INDEX_TARGET, 'dif', 'gt', 0),
            cond('index', INDEX_TARGET, 'dea', 'lt', 0),
          ]),
        ]),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(true);
  });

  it('向后兼容：扁平条件数组 + matchLogic=and 仍工作', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    const conditions: MatchNode[] = [
      cond('index', INDEX_TARGET, 'close', 'gt', 3000),
      cond('index', INDEX_TARGET, 'dif', 'gt', 0),
    ];
    expect(evaluateMarketConditions(s, conditions, 'and')).toBe(true);
  });

  it('向后兼容：扁平条件数组 + matchLogic=or 仍工作', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    const conditions: MatchNode[] = [
      cond('index', INDEX_TARGET, 'close', 'lt', 0),   // false
      cond('index', INDEX_TARGET, 'dif', 'gt', 0),     // true
    ];
    expect(evaluateMarketConditions(s, conditions, 'or')).toBe(true);
  });

  it('混合顶层：叶子 + MatchGroup，matchLogic=and 决定连接', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // 叶子: close>3000 (true), MatchGroup(or): dif<0∨dea<0 → false
    // and 连接: true ∧ false → false
    const conditions: MatchNode[] = [
      cond('index', INDEX_TARGET, 'close', 'gt', 3000),
      matchGroup('or', [
        cond('index', INDEX_TARGET, 'dif', 'lt', 0),
        cond('index', INDEX_TARGET, 'dea', 'lt', 0),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions, 'and')).toBe(false);

    // or 连接: true ∨ false → true
    expect(evaluateMarketConditions(s, conditions, 'or')).toBe(true);
  });

  it('空 items 的 MatchGroup → false (fail-closed)', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    const conditions: MatchNode[] = [
      matchGroup('and', []),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(false);

    const orEmpty: MatchNode[] = [
      matchGroup('or', []),
    ];
    expect(evaluateMarketConditions(s, orEmpty)).toBe(false);
  });

  it('MatchGroup 内短路求值：OR 组第一个为 true 即返回', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // close>3000 (true), 第二个条件 close<0 (false) — OR 短路，不检查第二个
    const conditions: MatchNode[] = [
      matchGroup('or', [
        cond('index', INDEX_TARGET, 'close', 'gt', 3000),
        cond('index', INDEX_TARGET, 'close', 'lt', 0),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(true);
  });

  it('MatchGroup 内短路求值：AND 组第一个为 false 即返回', () => {
    const s = makeSnapshot(new Map([[INDEX_TARGET, makeIndexTarget()]]));
    // close<0 (false), 第二个条件 close>0 — AND 短路，不检查第二个
    const conditions: MatchNode[] = [
      matchGroup('and', [
        cond('index', INDEX_TARGET, 'close', 'lt', 0),
        cond('index', INDEX_TARGET, 'close', 'gt', 0),
      ]),
    ];
    expect(evaluateMarketConditions(s, conditions)).toBe(false);
  });
});

describe('isMatchGroup type guard', () => {
  it('MatchGroup 对象返回 true', () => {
    const g: MatchGroup = { logic: 'and', items: [] };
    expect(isMatchGroup(g)).toBe(true);
  });

  it('叶子条件返回 false', () => {
    const c: RegimeBucketCondition = { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', value: 0 };
    expect(isMatchGroup(c)).toBe(false);
  });

  it('null/undefined/非对象返回 false', () => {
    expect(isMatchGroup(null)).toBe(false);
    expect(isMatchGroup(undefined)).toBe(false);
    expect(isMatchGroup(42)).toBe(false);
    expect(isMatchGroup('string')).toBe(false);
    expect(isMatchGroup([])).toBe(false);
  });

  it('含 type 字段的对象返回 false（区分叶子条件）', () => {
    // 即使有 logic 和 items，但有 type 字段 → 视为叶子（非 MatchGroup）
    expect(isMatchGroup({ type: 'index', logic: 'and', items: [] })).toBe(false);
  });
});

describe('collectMatchTargets', () => {
  it('扁平条件收集 index target', () => {
    const nodes: MatchNode[] = [
      cond('index', '000001.SH', 'macd', 'gt', 0),
      cond('index', '399001.SZ', 'dif', 'lt', 0),
    ];
    const result = collectMatchTargets(nodes);
    expect(result.index).toEqual(new Set(['000001.SH', '399001.SZ']));
    expect(result.stock.size).toBe(0);
  });

  it('扁平条件收集 stock target', () => {
    const nodes: MatchNode[] = [
      cond('stock', '000001.SZ', 'close', 'gt', 0),
    ];
    const result = collectMatchTargets(nodes);
    expect(result.stock).toEqual(new Set(['000001.SZ']));
    expect(result.index.size).toBe(0);
  });

  it('嵌套 MatchGroup 内叶子条件被正确收集', () => {
    const nodes: MatchNode[] = [
      matchGroup('or', [
        matchGroup('and', [
          cond('index', '000001.SH', 'macd', 'lt', 0),
          cond('index', '000985.CSI', 'dif', 'gt', 0),
        ]),
        matchGroup('and', [
          cond('index', '000001.SH', 'macd', 'gt', 0),
          cond('index', '000985.CSI', 'dif', 'lt', 0),
        ]),
      ]),
    ];
    const result = collectMatchTargets(nodes);
    expect(result.index).toEqual(new Set(['000001.SH', '000985.CSI']));
    expect(result.stock.size).toBe(0);
  });

  it('空数组返回空集合', () => {
    const result = collectMatchTargets([]);
    expect(result.index.size).toBe(0);
    expect(result.stock.size).toBe(0);
  });
});

describe('MARKET_CONDITION_FIELD_WHITELIST', () => {
  it('包含指数 24 个与个股字段，共正确总数', () => {
    const list = [...MARKET_CONDITION_FIELD_WHITELIST];
    const indexCount = list.filter((f) =>
      ['open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_change', 'vol_hand', 'amount', 'ma5', 'ma30', 'ma60', 'ma120', 'ma240', 'dif', 'dea', 'macd', 'kdj_k', 'kdj_d', 'kdj_j', 'bbi', 'brick', 'brick_delta', 'brick_xg'].includes(f),
    ).length;
    expect(indexCount).toBe(24);
    expect(list.length).toBeGreaterThan(24);
    expect(list).toContain('close');
    expect(list).toContain('macd_hist');
    expect(list).toContain('amv_dif');
  });
});
