/**
 * regime.classifier.spec.ts
 *
 * 参数化 regime 分类器单测。
 */
import { classifyRegime, RegimeResult } from './regime.classifier';
import { MarketSnapshot } from './market-condition-evaluator';
import { QuadrantEntry } from '../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';

function makeSnapshot(overrides?: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    oamv: {
      open: 100,
      high: 105,
      low: 99,
      close: 102,
      amvDif: 1.5,
      amvDea: 0.8,
      amvMacd: 1.4,
      ma5: 101,
      ma30: 98,
      ma60: 95,
      ma120: 90,
      ma240: 85,
      kdjK: 60,
      kdjD: 50,
      kdjJ: 80,
    },
    idx: null,
    ...overrides,
  } as MarketSnapshot;
}

function cond(field: string, operator: string, value?: number, compareField?: string): StrategyConditionItem {
  const c: StrategyConditionItem = { field, operator } as StrategyConditionItem;
  if (value !== undefined) c.value = value;
  if (compareField !== undefined) c.compareField = compareField;
  return c;
}

function makeQ1Q4Quadrants(): QuadrantEntry[] {
  return [
    {
      key: 'Q1',
      label: '强多头',
      action: 'trade',
      match: [cond('oamv_dif', 'gt', 0), cond('oamv_macd', 'gt', 0)],
    },
    {
      key: 'Q2',
      label: '多头回调',
      action: 'flat',
      match: [cond('oamv_dif', 'gt', 0), cond('oamv_macd', 'lte', 0)],
    },
    {
      key: 'Q3',
      label: '反弹筑底',
      action: 'trade',
      match: [cond('oamv_dif', 'lte', 0), cond('oamv_macd', 'gt', 0)],
    },
    {
      key: 'Q4',
      label: '空头',
      action: 'flat',
      match: [cond('oamv_dif', 'lte', 0), cond('oamv_macd', 'lte', 0)],
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

  it('0AMV 四象限 preset：边界 <= 归负侧', () => {
    const qs = makeQ1Q4Quadrants();
    const snapshot = (dif: number, macd: number) => makeSnapshot({ oamv: { ...makeSnapshot().oamv, amvDif: dif, amvMacd: macd } });

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

  it('oamv 任一指标为 null → unknown', () => {
    const qs = makeQ1Q4Quadrants();
    const s = makeSnapshot({ oamv: { ...makeSnapshot().oamv, amvDif: null } });
    expect(classifyRegime(s, qs)).toBe('unknown');
  });

  it('顺序优先级：首个命中的胜出', () => {
    const qs: QuadrantEntry[] = [
      { key: 'A', label: 'A', action: 'trade', match: [cond('oamv_dif', 'gt', 0)] },
      { key: 'B', label: 'B', action: 'trade', match: [cond('oamv_dif', 'gt', 0)] },
    ];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('A');
  });

  it('全部不命中 → unknown', () => {
    const qs: QuadrantEntry[] = [
      { key: 'A', label: 'A', action: 'trade', match: [cond('oamv_dif', 'lt', -100)] },
    ];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('unknown');
  });

  it('坏象限对象被跳过', () => {
    const qs = [
      { key: '', label: 'empty', action: 'trade', match: [cond('oamv_dif', 'gt', 0)] },
      { key: 'valid', label: 'valid', action: 'trade', match: [cond('oamv_dif', 'gt', 0)] },
    ] as QuadrantEntry[];
    expect(classifyRegime(makeSnapshot(), qs)).toBe('valid');
  });

  it('支持 idx 字段分桶', () => {
    const qs: QuadrantEntry[] = [
      {
        key: 'idx_bull',
        label: '上证多头',
        action: 'trade',
        match: [cond('idx_close', 'gt', 3000), cond('idx_macd', 'gt', 0)],
      },
    ];
    const s = makeSnapshot({
      idx: {
        quote: {
          open: 3000,
          high: 3050,
          low: 2990,
          close: 3040,
          preClose: 3020,
          change: 20,
          pctChange: 0.66,
          volHand: 1_000_000,
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
          kdjK: 55,
          kdjD: 45,
          kdjJ: 75,
          bbi: 3005,
          brick: 1,
          brickDelta: 0.5,
          brickXg: true,
        },
      },
    });
    expect(classifyRegime(s, qs)).toBe('idx_bull');
  });

  it('idx 为 null 但 match 用 idx 字段 → unknown', () => {
    const qs: QuadrantEntry[] = [
      { key: 'x', label: 'x', action: 'trade', match: [cond('idx_close', 'gt', 0)] },
    ];
    expect(classifyRegime(makeSnapshot({ idx: null }), qs)).toBe('unknown');
  });
});
