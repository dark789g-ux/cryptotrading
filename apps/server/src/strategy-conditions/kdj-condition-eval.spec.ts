import { kdjLineOf, evalKdjCondition } from './kdj-condition-eval';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 构造一个 recomp 结果（curr 必填，prev 可空）。 */
function mk(
  curr: { k: number; d: number; j: number },
  prev: { k: number; d: number; j: number } | null = null,
): { curr: { k: number; d: number; j: number }; prev: { k: number; d: number; j: number } | null } {
  return { curr, prev };
}

/** 构造一条条件（最小字段）。 */
function cond(c: Partial<StrategyConditionItem> & Pick<StrategyConditionItem, 'field' | 'operator'>): StrategyConditionItem {
  return c as StrategyConditionItem;
}

describe('kdjLineOf', () => {
  it('maps three KDJ field keys to k/d/j', () => {
    expect(kdjLineOf('kdj_k')).toBe('k');
    expect(kdjLineOf('kdj_d')).toBe('d');
    expect(kdjLineOf('kdj_j')).toBe('j');
  });
});

describe('evalKdjCondition — comparison vs value', () => {
  it('gt true / false', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_j', operator: 'gt', value: 80 }), mk({ k: 50, d: 50, j: 90 }))).toBe(true);
    expect(evalKdjCondition(cond({ field: 'kdj_j', operator: 'gt', value: 80 }), mk({ k: 50, d: 50, j: 70 }))).toBe(false);
  });

  it('gte boundary inclusive', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_k', operator: 'gte', value: 50 }), mk({ k: 50, d: 0, j: 0 }))).toBe(true);
  });

  it('lt true / false', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_j', operator: 'lt', value: 0 }), mk({ k: 10, d: 10, j: -5 }))).toBe(true);
    expect(evalKdjCondition(cond({ field: 'kdj_j', operator: 'lt', value: 0 }), mk({ k: 10, d: 10, j: 5 }))).toBe(false);
  });

  it('lte boundary inclusive', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_d', operator: 'lte', value: 20 }), mk({ k: 0, d: 20, j: 0 }))).toBe(true);
  });

  it('eq / neq', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_k', operator: 'eq', value: 50 }), mk({ k: 50, d: 0, j: 0 }))).toBe(true);
    expect(evalKdjCondition(cond({ field: 'kdj_k', operator: 'eq', value: 50 }), mk({ k: 51, d: 0, j: 0 }))).toBe(false);
    expect(evalKdjCondition(cond({ field: 'kdj_k', operator: 'neq', value: 50 }), mk({ k: 51, d: 0, j: 0 }))).toBe(true);
    expect(evalKdjCondition(cond({ field: 'kdj_k', operator: 'neq', value: 50 }), mk({ k: 50, d: 0, j: 0 }))).toBe(false);
  });

  it('undefined right-hand value (no compareField, no value) → false', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_j', operator: 'gt' }), mk({ k: 0, d: 0, j: 100 }))).toBe(false);
  });
});

describe('evalKdjCondition — comparison vs field', () => {
  it('k > d using compareField', () => {
    expect(
      evalKdjCondition(cond({ field: 'kdj_k', operator: 'gt', compareField: 'kdj_d' }), mk({ k: 60, d: 50, j: 0 })),
    ).toBe(true);
    expect(
      evalKdjCondition(cond({ field: 'kdj_k', operator: 'gt', compareField: 'kdj_d' }), mk({ k: 40, d: 50, j: 0 })),
    ).toBe(false);
  });

  it('j < k using compareField', () => {
    expect(
      evalKdjCondition(cond({ field: 'kdj_j', operator: 'lt', compareField: 'kdj_k' }), mk({ k: 50, d: 0, j: 30 })),
    ).toBe(true);
  });
});

describe('evalKdjCondition — cross vs value', () => {
  it('cross_above value: prev < v && curr > v → true', () => {
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_j', operator: 'cross_above', value: 0 }),
        mk({ k: 0, d: 0, j: 5 }, { k: 0, d: 0, j: -3 }),
      ),
    ).toBe(true);
  });

  it('cross_above value: prev already above → false', () => {
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_j', operator: 'cross_above', value: 0 }),
        mk({ k: 0, d: 0, j: 5 }, { k: 0, d: 0, j: 2 }),
      ),
    ).toBe(false);
  });

  it('cross_below value: prev > v && curr < v → true', () => {
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_j', operator: 'cross_below', value: 80 }),
        mk({ k: 0, d: 0, j: 70 }, { k: 0, d: 0, j: 90 }),
      ),
    ).toBe(true);
  });

  it('cross strict inequality: equal at boundary → false', () => {
    // prev == v (not strictly <) → cross_above false
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_j', operator: 'cross_above', value: 0 }),
        mk({ k: 0, d: 0, j: 5 }, { k: 0, d: 0, j: 0 }),
      ),
    ).toBe(false);
  });
});

describe('evalKdjCondition — cross vs field', () => {
  it('k cross_above d: prevK<prevD && currK>currD → true', () => {
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_k', operator: 'cross_above', compareField: 'kdj_d' }),
        mk({ k: 55, d: 50, j: 0 }, { k: 45, d: 50, j: 0 }),
      ),
    ).toBe(true);
  });

  it('k cross_above d: not crossing (already above) → false', () => {
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_k', operator: 'cross_above', compareField: 'kdj_d' }),
        mk({ k: 55, d: 50, j: 0 }, { k: 52, d: 50, j: 0 }),
      ),
    ).toBe(false);
  });

  it('k cross_below d: prevK>prevD && currK<currD → true', () => {
    expect(
      evalKdjCondition(
        cond({ field: 'kdj_k', operator: 'cross_below', compareField: 'kdj_d' }),
        mk({ k: 45, d: 50, j: 0 }, { k: 55, d: 50, j: 0 }),
      ),
    ).toBe(true);
  });
});

describe('evalKdjCondition — prev=null', () => {
  it('cross_above with prev=null → false', () => {
    expect(
      evalKdjCondition(cond({ field: 'kdj_j', operator: 'cross_above', value: 0 }), mk({ k: 0, d: 0, j: 5 }, null)),
    ).toBe(false);
  });

  it('cross_below with prev=null → false', () => {
    expect(
      evalKdjCondition(cond({ field: 'kdj_k', operator: 'cross_below', compareField: 'kdj_d' }), mk({ k: 0, d: 0, j: 0 }, null)),
    ).toBe(false);
  });

  it('plain comparison still works with prev=null', () => {
    expect(evalKdjCondition(cond({ field: 'kdj_j', operator: 'gt', value: 0 }), mk({ k: 0, d: 0, j: 5 }, null))).toBe(true);
  });
});
