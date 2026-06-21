/**
 * ROC（动量/变化率）筛选条件单测 —— 落库方案（读预存列 roc10/20/60）。
 *
 * ROC 三档走 query-builder 的普通字段分支（与 ma5/kdj_j 一样），
 * 自动支持 gt/gte/lt/lte/eq/neq/cross_above/cross_below 全部操作符。
 */
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 折叠所有空白便于做不受换行/缩进影响的子串断言 */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('StrategyConditionsQueryBuilder — ROC（动量，预存列）', () => {
  let builder: StrategyConditionsQueryBuilder;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    builder = new StrategyConditionsQueryBuilder();
    warnSpy = jest
      .spyOn((builder as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ── A 股：读 i.roc10/20/60 预存列 ────────────────────────────────────────────

  it('A 股 roc20 gt 5 → i.roc20 > $1，params=[5]', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc20', operator: 'gt', value: 5 }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('i.roc20 > $1');
    expect(params).toEqual([5]);
  });

  it('A 股 roc10 lte 0 → i.roc10 <= $1', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc10', operator: 'lte', value: 0 }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('i.roc10 <= $1');
    expect(params).toEqual([0]);
  });

  it('A 股 roc60 gt ma5（字段对字段）→ i.roc60 > i.ma5，无新增 param', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc60', operator: 'gt', compareField: 'ma5', compareMode: 'field' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('i.roc60 > i.ma5');
    expect(params).toEqual([]);
  });

  // ── cross（字段穿越字段）：落库后走 query-builder 现有 cross 逻辑，自动支持 ─────
  // 注：query-builder 的 cross 只支持字段对字段（compareField），不支持穿越常量值；
  // 「穿越 0 轴」需另造一个常量 0 的伪字段，超出本设计范围。

  it('A 股 roc10 cross_above roc20 → EXISTS 前一根子查询', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc10', operator: 'cross_above', compareField: 'roc20', compareMode: 'field' },
    ];
    const { sql } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('EXISTS (');
    expect(flat).toContain('prev.roc10 < prev.roc20');
    expect(flat).toContain('i.roc10 > i.roc20');
  });

  // ── crypto：读 k.roc10/20/60 ────────────────────────────────────────────────

  it('crypto roc20 lt 0 → k.roc20 < $1，params=[0]', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc20', operator: 'lt', value: 0 }];
    const { sql, params } = builder.buildCryptoQuery(conditions);
    expect(squash(sql)).toContain('k.roc20 < $1');
    expect(params).toEqual([0]);
  });

  it('crypto roc10 cross_below roc20 → 走 klines prev 子查询', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc10', operator: 'cross_below', compareField: 'roc20', compareMode: 'field' },
    ];
    const { sql } = builder.buildCryptoQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('EXISTS (');
    expect(flat).toContain('prev.roc10 > prev.roc20');
    expect(flat).toContain('k.roc10 < k.roc20');
  });

  // ── 多条件 AND ──────────────────────────────────────────────────────────────

  it('多条件 AND：roc20 gt 5 + kdj_j gt 20 → 两段 AND，占位对齐', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc20', operator: 'gt', value: 5 },
      { field: 'kdj_j', operator: 'gt', value: 20 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('i.roc20 > $1');
    expect(flat).toContain('i.kdj_j > $2');
    expect(flat).toContain(' AND ');
    expect(params).toEqual([5, 20]);
  });
});
