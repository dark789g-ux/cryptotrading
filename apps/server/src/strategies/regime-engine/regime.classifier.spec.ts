/**
 * regime.classifier.spec.ts
 *
 * 参数化 regime 分类器单测（v3 snapshot + 分桶条件）。
 */
import { classifyRegime, isSingleWildcardQuadrant, RegimeResult } from './regime.classifier';
import { MarketSnapshot, IndexTargetSnapshot } from './market-condition-evaluator';
import { QuadrantEntry, RegimeBucketCondition } from '../../entities/strategy/regime-strategy-config.entity';

const INDEX_TARGET = '000001.SH';

function makeIndexTarget(indicatorOverrides?: Partial<IndexTargetSnapshot['indicator']>): IndexTargetSnapshot {
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
      ...indicatorOverrides,
    },
  };
}

function makeSnapshot(indicatorOverrides?: Partial<IndexTargetSnapshot['indicator']>): MarketSnapshot {
  return {
    date: '20260610',
    targets: new Map([[INDEX_TARGET, makeIndexTarget(indicatorOverrides)]]),
  };
}

function cond(
  field: string,
  operator: string,
  value?: number,
  compareField?: string,
  compareMode?: 'value' | 'field',
): RegimeBucketCondition {
  const c: RegimeBucketCondition = {
    type: 'index',
    target: INDEX_TARGET,
    field,
    operator,
  };
  if (value !== undefined) c.value = value;
  if (compareField !== undefined) c.compareField = compareField;
  if (compareMode !== undefined) c.compareMode = compareMode;
  return c;
}

function makeQ1Q4Quadrants(): QuadrantEntry[] {
  return [
    {
      key: 'Q1',
      label: '强多头',
      action: 'trade',
      match: [cond('dif', 'gt', 0), cond('macd', 'gt', 0)],
    },
    {
      key: 'Q2',
      label: '多头回调',
      action: 'flat',
      match: [cond('dif', 'gt', 0), cond('macd', 'lte', 0)],
    },
    {
      key: 'Q3',
      label: '反弹筑底',
      action: 'trade',
      match: [cond('dif', 'lte', 0), cond('macd', 'gt', 0)],
    },
    {
      key: 'Q4',
      label: '空头',
      action: 'flat',
      match: [cond('dif', 'lte', 0), cond('macd', 'lte', 0)],
    },
  ];
}

describe('classifyRegime', () => {
  it('非法输入返回 unknown', () => {
    const qs = makeQ1Q4Quadrants();
    expect(classifyRegime(null as unknown as MarketSnapshot, qs)).toBe('unknown');
    expect(classifyRegime(undefined as unknown as MarketSnapshot, qs)).toBe('unknown');
    expect(classifyRegime({} as MarketSnapshot, qs)).toBe('unknown');
    expect(classifyRegime(makeSnapshot(), [])).toBe('unknown');
    expect(classifyRegime(makeSnapshot(), undefined as unknown as QuadrantEntry[])).toBe('unknown');
  });

  it('指数四象限 preset：边界 <= 归负侧', () => {
    const qs = makeQ1Q4Quadrants();
    const snapshot = (dif: number, macd: number) => makeSnapshot({ dif, macd });

    expect(classifyRegime(snapshot(1.5, 0.3), qs)).toBe('Q1');
    expect(classifyRegime(snapshot(1.5, -0.3), qs)).toBe('Q2');
    expect(classifyRegime(snapshot(-1.5, 0.3), qs)).toBe('Q3');
    expect(classifyRegime(snapshot(-1.5, -0.3), qs)).toBe('Q4');

    expect(classifyRegime(snapshot(1.5, 0), qs)).toBe('Q2');
    expect(classifyRegime(snapshot(0, 0.3), qs)).toBe('Q3');
    expect(classifyRegime(snapshot(0, 0), qs)).toBe('Q4');
    expect(classifyRegime(snapshot(0, -0.3), qs)).toBe('Q4');
    expect(classifyRegime(snapshot(-1.5, 0), qs)).toBe('Q4');
  });

  it('任一指标为 null → unknown', () => {
    const qs = makeQ1Q4Quadrants();
    const s = makeSnapshot({ dif: null });
    expect(classifyRegime(s, qs)).toBe('unknown');
  });

  it('顺序优先级：首个命中的胜出', () => {
    const qs: QuadrantEntry[] = [
      { key: 'A', label: 'A', action: 'trade', match: [cond('dif', 'gt', 0)] },
      { key: 'B', label: 'B', action: 'trade', match: [cond('dif', 'gt', 0)] },
    ];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('A');
  });

  it('全部不命中 → unknown', () => {
    const qs: QuadrantEntry[] = [
      { key: 'A', label: 'A', action: 'trade', match: [cond('dif', 'lt', -100)] },
    ];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('unknown');
  });

  it('坏象限对象被跳过', () => {
    const qs = [
      { key: '', label: 'empty', action: 'trade', match: [cond('dif', 'gt', 0)] },
      { key: 'valid', label: 'valid', action: 'trade', match: [cond('dif', 'gt', 0)] },
    ] as QuadrantEntry[];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('valid');
  });

  it('支持 compareMode=field 分桶', () => {
    const qs: QuadrantEntry[] = [
      {
        key: 'close_above_ma60',
        label: '上证站上 MA60',
        action: 'trade',
        match: [cond('close', 'gt', undefined, 'ma60', 'field')],
      },
    ];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('close_above_ma60');
  });

  it('目标缺失但 match 使用该目标 → unknown', () => {
    const qs: QuadrantEntry[] = [
      { key: 'x', label: 'x', action: 'trade', match: [cond('close', 'gt', 0)] },
    ];
    const emptySnapshot: MarketSnapshot = { date: '20260610', targets: new Map() };
    expect(classifyRegime(emptySnapshot, qs)).toBe('unknown');
  });

  it('单象限空 match 通配：任何 snapshot 都命中', () => {
    const qs: QuadrantEntry[] = [
      { key: 'only', label: '唯一', action: 'trade', match: [] },
    ];
    // 正常 snapshot
    expect(classifyRegime(makeSnapshot(), qs)).toBe('only');
    // 空 targets snapshot
    expect(classifyRegime({ date: '20260610', targets: new Map() }, qs)).toBe('only');
  });

  it('单象限空 match 通配优先于 evaluateMarketConditions', () => {
    const qs: QuadrantEntry[] = [
      { key: 'solo', label: 'solo', action: 'flat', match: [] },
    ];
    expect(classifyRegime({ date: '20260610', targets: new Map() }, qs)).toBe('solo');
  });

  it('多象限下 match 空的象限被跳过（不通配）', () => {
    // 回归：多象限下空 match 不触发通配
    const qs: QuadrantEntry[] = [
      { key: 'empty', label: 'empty', action: 'trade', match: [] },
      { key: 'real', label: 'real', action: 'trade', match: [cond('dif', 'gt', 0)] },
    ];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('real');
  });
});

describe('isSingleWildcardQuadrant', () => {
  it('单象限空 match → true', () => {
    expect(isSingleWildcardQuadrant([{ key: 'a', match: [] }])).toBe(true);
  });

  it('单象限非空 match → false', () => {
    expect(isSingleWildcardQuadrant([{ key: 'a', match: [cond('dif', 'gt', 0)] }])).toBe(false);
  });

  it('多象限 → false（即使某个 match 为空）', () => {
    expect(isSingleWildcardQuadrant([{ key: 'a', match: [] }, { key: 'b', match: [cond('dif', 'gt', 0)] }])).toBe(false);
  });

  it('空数组 / null / 非数组 → false', () => {
    expect(isSingleWildcardQuadrant([])).toBe(false);
    expect(isSingleWildcardQuadrant(null)).toBe(false);
    expect(isSingleWildcardQuadrant(undefined)).toBe(false);
    expect(isSingleWildcardQuadrant('abc')).toBe(false);
  });

  it('match 不是数组 → false', () => {
    expect(isSingleWildcardQuadrant([{ key: 'a', match: null as any }])).toBe(false);
  });
});
