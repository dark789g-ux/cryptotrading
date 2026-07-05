/**
 * market-condition-evaluator.spec.ts
 *
 * 大盘条件求值器 TDD 单测。
 */
import {
  evaluateMarketConditions,
  MarketSnapshot,
  MARKET_CONDITION_FIELD_WHITELIST,
} from './market-condition-evaluator';
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
    ...overrides,
  } as MarketSnapshot;
}

function cond(field: string, operator: string, value?: number, compareField?: string): StrategyConditionItem {
  const c: StrategyConditionItem = { field, operator } as StrategyConditionItem;
  if (value !== undefined) c.value = value;
  if (compareField !== undefined) c.compareField = compareField;
  return c;
}

describe('evaluateMarketConditions', () => {
  it('空条件数组 fail-closed', () => {
    expect(evaluateMarketConditions(makeSnapshot(), [])).toBe(false);
  });

  it('oamv 常量比较命中', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'gt', 0)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('oamv_macd', 'gt', 0)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('oamv_close', 'gte', 102)])).toBe(true);
  });

  it('oamv 常量比较不命中', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'lt', 0)])).toBe(false);
    expect(evaluateMarketConditions(s, [cond('oamv_macd', 'lte', 0)])).toBe(false);
  });

  it('idx 常量比较命中', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('idx_close', 'gt', 3000)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('idx_ma60', 'lt', 3000)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('idx_macd', 'eq', 10)])).toBe(true);
  });

  it('idx 为 null 时用 idx 字段 fail-closed', () => {
    const s = makeSnapshot({ idx: null });
    expect(evaluateMarketConditions(s, [cond('idx_close', 'gt', 0)])).toBe(false);
  });

  it('compareField 命中与不命中', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'gt', undefined, 'oamv_dea')])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('idx_close', 'gt', undefined, 'idx_ma60')])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'lt', undefined, 'oamv_dea')])).toBe(false);
  });

  it('compareField 越界 fail-closed', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'gt', undefined, 'unknown_field')])).toBe(false);
  });

  it('多条件 AND 语义', () => {
    const s = makeSnapshot();
    expect(
      evaluateMarketConditions(s, [
        cond('oamv_dif', 'gt', 0),
        cond('oamv_macd', 'gt', 0),
        cond('idx_close', 'gt', 3000),
      ]),
    ).toBe(true);
    expect(
      evaluateMarketConditions(s, [
        cond('oamv_dif', 'gt', 0),
        cond('oamv_macd', 'lt', 0),
      ]),
    ).toBe(false);
  });

  it('未知字段 fail-closed', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [{ field: 'unknown', operator: 'gt', value: 0 }])).toBe(false);
  });

  it('不支持 cross 操作符', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [{ field: 'oamv_dif', operator: 'cross_above', value: 0 }])).toBe(false);
    expect(evaluateMarketConditions(s, [{ field: 'oamv_dif', operator: 'cross_below', value: 0 }])).toBe(false);
  });

  it('非法 value fail-closed', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [{ field: 'oamv_dif', operator: 'gt', value: NaN }])).toBe(false);
    expect(evaluateMarketConditions(s, [{ field: 'oamv_dif', operator: 'gt', value: Infinity }])).toBe(false);
  });

  it('字段值为 null / NaN 时 fail-closed', () => {
    const s = makeSnapshot({
      oamv: { ...makeSnapshot().oamv, amvDif: null },
    });
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'gt', 0)])).toBe(false);
  });

  it('boolean 字段按 1/0 比较', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('idx_brick_xg', 'eq', 1)])).toBe(true);
    expect(evaluateMarketConditions(s, [cond('idx_brick_xg', 'eq', 0)])).toBe(false);
  });

  it('neq 操作符', () => {
    const s = makeSnapshot();
    expect(evaluateMarketConditions(s, [cond('oamv_dif', 'neq', 0)])).toBe(true);
  });
});

describe('MARKET_CONDITION_FIELD_WHITELIST', () => {
  it('包含 oamv 15 个与 idx 24 个字段，共 39 个', () => {
    const list = [...MARKET_CONDITION_FIELD_WHITELIST];
    const oamvCount = list.filter((f) => f.startsWith('oamv_')).length;
    const idxCount = list.filter((f) => f.startsWith('idx_')).length;
    expect(oamvCount).toBe(15);
    expect(idxCount).toBe(24);
    expect(list.length).toBe(39);
  });
});
