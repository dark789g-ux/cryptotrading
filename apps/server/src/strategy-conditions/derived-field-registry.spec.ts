import { DerivedFieldRegistry, DerivedFieldSnapshot } from './derived-field-registry';
import { DerivedFieldRecomputer } from './derived-field-registry';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 构造一条条件(最小字段)。 */
function cond(
  c: Partial<StrategyConditionItem> &
    Pick<StrategyConditionItem, 'field' | 'operator'>,
): StrategyConditionItem {
  return c as StrategyConditionItem;
}

/** 创建 mock recomputer:只匹配指定 field。 */
function mockRecomputer(
  name: string,
  matchFields: string[],
): DerivedFieldRecomputer {
  return {
    name,
    needsRecompute: (c) => matchFields.includes(c.field),
    recomputeLatest: jest.fn(),
    evaluate: jest.fn(),
  };
}

describe('DerivedFieldRegistry', () => {
  it('register + resolve finds correct recomputer', () => {
    const reg = new DerivedFieldRegistry();
    const ma = mockRecomputer('ma', ['ma20', 'ma10']);
    const kdj = mockRecomputer('kdj', ['kdj_j', 'kdj_k']);
    reg.register(ma);
    reg.register(kdj);

    expect(reg.resolve(cond({ field: 'ma20', operator: 'gt' }))).toBe(ma);
    expect(reg.resolve(cond({ field: 'kdj_j', operator: 'gt' }))).toBe(kdj);
    expect(reg.resolve(cond({ field: 'macd_dif', operator: 'gt' }))).toBeNull();
  });

  it('resolve returns null for unrecognized field', () => {
    const reg = new DerivedFieldRegistry();
    expect(
      reg.resolve(cond({ field: 'unknown_field', operator: 'gt' })),
    ).toBeNull();
  });

  describe('split', () => {
    it('correctly divides conditions into sqlConds and recompConds', () => {
      const reg = new DerivedFieldRegistry();
      const ma = mockRecomputer('ma', ['ma20', 'ma10']);
      reg.register(ma);

      const conditions: StrategyConditionItem[] = [
        cond({ field: 'ma20', operator: 'gt', value: 10 }),
        cond({ field: 'ma5', operator: 'gt', value: 5 }),   // not in COL_MAP for mock, but mock only matches ma20/ma10
        cond({ field: 'kdj_j', operator: 'gt', value: 50 }),  // no kdj recomputer registered
        cond({ field: 'ma10', operator: 'lt', value: 15 }),
      ];

      const { sqlConds, recompConds } = reg.split(conditions);
      expect(sqlConds).toHaveLength(2);
      expect(recompConds).toHaveLength(2);

      // ma20 and ma10 go to recompConds
      const recompFields = recompConds.map((c) => c.field);
      expect(recompFields).toContain('ma20');
      expect(recompFields).toContain('ma10');

      // ma5 and kdj_j go to sqlConds (no matching recomputer)
      const sqlFields = sqlConds.map((c) => c.field);
      expect(sqlFields).toContain('ma5');
      expect(sqlFields).toContain('kdj_j');
    });

    it('returns all sqlConds when no recomputer registered', () => {
      const reg = new DerivedFieldRegistry();
      const conditions: StrategyConditionItem[] = [
        cond({ field: 'ma20', operator: 'gt' }),
        cond({ field: 'kdj_j', operator: 'gt' }),
      ];

      const { sqlConds, recompConds } = reg.split(conditions);
      expect(sqlConds).toHaveLength(2);
      expect(recompConds).toHaveLength(0);
    });

    it('returns empty arrays for empty input', () => {
      const reg = new DerivedFieldRegistry();
      const { sqlConds, recompConds } = reg.split([]);
      expect(sqlConds).toHaveLength(0);
      expect(recompConds).toHaveLength(0);
    });
  });

  describe('hasRecomputeNeeds', () => {
    it('returns true when any condition needs recompute', () => {
      const reg = new DerivedFieldRegistry();
      const ma = mockRecomputer('ma', ['ma20']);
      reg.register(ma);

      expect(
        reg.hasRecomputeNeeds([
          cond({ field: 'ma5', operator: 'gt' }),
          cond({ field: 'ma20', operator: 'gt' }),
        ]),
      ).toBe(true);
    });

    it('returns false when no condition needs recompute', () => {
      const reg = new DerivedFieldRegistry();
      const ma = mockRecomputer('ma', ['ma20']);
      reg.register(ma);

      expect(
        reg.hasRecomputeNeeds([
          cond({ field: 'ma5', operator: 'gt' }),
          cond({ field: 'kdj_j', operator: 'gt' }),
        ]),
      ).toBe(false);
    });
  });
});
