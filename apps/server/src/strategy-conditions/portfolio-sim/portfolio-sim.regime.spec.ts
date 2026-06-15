/**
 * portfolio-sim.regime.spec.ts
 *
 * regime 求值器单测（spec 05 / 10）：
 *  - evalOamvCondition 各 operator（gt/lt/gte/lte/eq/neq）+ compareField 字段比较
 *  - 未知字段 / lhs==null / rhs==null / 未知 compareField / cross_* → fail-closed=false
 *  - resolveRegime：命中 / 首个优先 / 无命中 / bar=null / 字段 NULL fail-closed
 *
 * 纯函数、零 DB。
 */

import { evalOamvCondition, resolveRegime } from './portfolio-sim.regime';
import { OamvBar, RegimeRule } from './portfolio-sim.types';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';

function bar(overrides: Partial<OamvBar> = {}): OamvBar {
  return {
    amvDif: 1,
    amvDea: 0,
    amvMacd: 2,
    close: 100,
    ma240: 90,
    ...overrides,
  };
}

function cond(o: Partial<StrategyConditionItem> & { field: string; operator: StrategyConditionItem['operator'] }): StrategyConditionItem {
  return { value: undefined, compareField: undefined, ...o } as StrategyConditionItem;
}

// ─────────────────────────────────────────────────────────────────────────────
// evalOamvCondition：各 operator（value 比较）
// ─────────────────────────────────────────────────────────────────────────────
describe('evalOamvCondition — operator（与常量 value 比较）', () => {
  const b = bar({ amvDif: 5 });

  it('gt 真/假', () => {
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'gt', value: 4 }), b)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'gt', value: 5 }), b)).toBe(false);
  });
  it('gte 边界', () => {
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'gte', value: 5 }), b)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'gte', value: 6 }), b)).toBe(false);
  });
  it('lt 真/假', () => {
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'lt', value: 6 }), b)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'lt', value: 5 }), b)).toBe(false);
  });
  it('lte 边界', () => {
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'lte', value: 5 }), b)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'lte', value: 4 }), b)).toBe(false);
  });
  it('eq / neq', () => {
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'eq', value: 5 }), b)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'eq', value: 4 }), b)).toBe(false);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'neq', value: 4 }), b)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'neq', value: 5 }), b)).toBe(false);
  });

  it('全部 5 个字段都可作 lhs', () => {
    const b2 = bar({ amvDif: 1, amvDea: 2, amvMacd: 3, close: 4, ma240: 5 });
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'eq', value: 1 }), b2)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_dea', operator: 'eq', value: 2 }), b2)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_macd', operator: 'eq', value: 3 }), b2)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_close', operator: 'eq', value: 4 }), b2)).toBe(true);
    expect(evalOamvCondition(cond({ field: 'oamv_ma240', operator: 'eq', value: 5 }), b2)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evalOamvCondition：compareField（字段 vs 字段）
// ─────────────────────────────────────────────────────────────────────────────
describe('evalOamvCondition — compareField（字段 vs 字段）', () => {
  it('close > ma240 命中', () => {
    const b = bar({ close: 100, ma240: 90 });
    expect(
      evalOamvCondition(cond({ field: 'oamv_close', operator: 'gt', compareField: 'oamv_ma240' }), b),
    ).toBe(true);
  });
  it('close < ma240 不命中', () => {
    const b = bar({ close: 80, ma240: 90 });
    expect(
      evalOamvCondition(cond({ field: 'oamv_close', operator: 'gt', compareField: 'oamv_ma240' }), b),
    ).toBe(false);
  });
  it('compareField 优先于 value（同时给 value 也走字段比较）', () => {
    const b = bar({ close: 100, ma240: 90 });
    // value=99999 会让 value 路径必假；走 compareField 才命中
    expect(
      evalOamvCondition(
        cond({ field: 'oamv_close', operator: 'gt', value: 99999, compareField: 'oamv_ma240' }),
        b,
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evalOamvCondition：fail-closed
// ─────────────────────────────────────────────────────────────────────────────
describe('evalOamvCondition — fail-closed', () => {
  it('lhs 字段值 NULL → false', () => {
    const b = bar({ ma240: null });
    expect(evalOamvCondition(cond({ field: 'oamv_ma240', operator: 'gt', value: 0 }), b)).toBe(false);
  });
  it('未知 lhs 字段 → false', () => {
    const b = bar();
    expect(evalOamvCondition(cond({ field: 'oamv_unknown', operator: 'gt', value: 0 }), b)).toBe(false);
  });
  it('rhs value 缺失（既无 compareField 又无 value）→ false', () => {
    const b = bar({ amvDif: 5 });
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'gt' }), b)).toBe(false);
  });
  it('compareField 指向 NULL 字段 → false', () => {
    const b = bar({ close: 100, ma240: null });
    expect(
      evalOamvCondition(cond({ field: 'oamv_close', operator: 'gt', compareField: 'oamv_ma240' }), b),
    ).toBe(false);
  });
  it('未知 compareField → false', () => {
    const b = bar({ close: 100 });
    expect(
      evalOamvCondition(cond({ field: 'oamv_close', operator: 'gt', compareField: 'oamv_bogus' }), b),
    ).toBe(false);
  });
  it('cross_above / cross_below → false（不支持）', () => {
    const b = bar({ amvDif: 5 });
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'cross_above', value: 0 }), b)).toBe(false);
    expect(evalOamvCondition(cond({ field: 'oamv_dif', operator: 'cross_below', value: 0 }), b)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRegime
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveRegime', () => {
  const rule1: RegimeRule = {
    conditions: [
      cond({ field: 'oamv_macd', operator: 'gt', value: 0 }),
      cond({ field: 'oamv_dif', operator: 'gt', value: 0 }),
    ],
    maxPositions: 2,
    positionRatio: 0.45,
  };
  const rule2: RegimeRule = {
    conditions: [
      cond({ field: 'oamv_macd', operator: 'lt', value: 0 }),
      cond({ field: 'oamv_dif', operator: 'gt', value: 0 }),
    ],
    maxPositions: 5,
    positionRatio: 0.2,
  };

  it('命中 rule1（macd>0 且 dif>0）', () => {
    expect(resolveRegime(bar({ amvMacd: 2, amvDif: 1 }), [rule1, rule2])).toEqual({
      maxPositions: 2,
      positionRatio: 0.45,
    });
  });

  it('命中 rule2（macd<0 且 dif>0）', () => {
    expect(resolveRegime(bar({ amvMacd: -2, amvDif: 1 }), [rule1, rule2])).toEqual({
      maxPositions: 5,
      positionRatio: 0.2,
    });
  });

  it('首个优先：两 rule 都满足时返回靠前者', () => {
    // 构造同时满足两条的 bar（rule1: macd>0&dif>0；rule2: macd>-100&dif>0）
    const wide2: RegimeRule = {
      conditions: [cond({ field: 'oamv_dif', operator: 'gt', value: 0 })],
      maxPositions: 9,
      positionRatio: 0.9,
    };
    expect(resolveRegime(bar({ amvMacd: 2, amvDif: 1 }), [rule1, wide2])).toEqual({
      maxPositions: 2,
      positionRatio: 0.45,
    });
    // 交换顺序 → 返回 wide2
    expect(resolveRegime(bar({ amvMacd: 2, amvDif: 1 }), [wide2, rule1])).toEqual({
      maxPositions: 9,
      positionRatio: 0.9,
    });
  });

  it('无命中（macd>0 但 dif<0，两条都不全 AND）→ null', () => {
    expect(resolveRegime(bar({ amvMacd: 2, amvDif: -1 }), [rule1, rule2])).toBeNull();
  });

  it('bar==null（缺数据）→ null', () => {
    expect(resolveRegime(null, [rule1, rule2])).toBeNull();
  });

  it('引用字段 NULL（fail-closed）→ 该 rule 不命中 → null', () => {
    // macd=NULL 让 rule1/rule2 的 macd 条件都 false
    expect(resolveRegime(bar({ amvMacd: null, amvDif: 1 }), [rule1, rule2])).toBeNull();
  });

  it('空 regimes 数组 → null', () => {
    expect(resolveRegime(bar(), [])).toBeNull();
  });

  it('conditions 全 AND：一条不满足即整 rule 落空', () => {
    // dif=−1 让 rule1 第二条不满足，rule2 第一条也不满足 → 都落空
    expect(resolveRegime(bar({ amvMacd: 2, amvDif: -1 }), [rule1])).toBeNull();
  });
});
