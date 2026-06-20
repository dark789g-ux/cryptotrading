import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 折叠所有空白便于做不受换行/缩进影响的子串断言 */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('StrategyConditionsQueryBuilder — ROC（动量）字段', () => {
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

  // ── resolveRocN 周期边界（通过 OFFSET 间接验证）────────────────────────────────

  it('周期缺省 → OFFSET 10（默认 N）', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc', operator: 'gt', value: 5 }];
    const { sql } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('OFFSET 10 LIMIT 1');
  });

  it('周期 n=0 非法 → 回退 OFFSET 10', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', value: 5, rocParams: { n: 0 } },
    ];
    const { sql } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('OFFSET 10 LIMIT 1');
  });

  it('周期 n=251 越界 → 回退 OFFSET 10', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', value: 5, rocParams: { n: 251 } },
    ];
    const { sql } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('OFFSET 10 LIMIT 1');
  });

  it('周期 n=10（显式等于默认）→ OFFSET 10', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', value: 5, rocParams: { n: 10 } },
    ];
    const { sql } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('OFFSET 10 LIMIT 1');
  });

  it('周期 n=20 → OFFSET 20', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', value: 5, rocParams: { n: 20 } },
    ];
    const { sql } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('OFFSET 20 LIMIT 1');
  });

  // ── A 股 ROC SQL 结构 ──────────────────────────────────────────────────────────

  it('A 股 roc gt 5 → qfq_close 变化率表达式 + raw.daily_quote + params=[5]', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc', operator: 'gt', value: 5 }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    // 变化率公式
    expect(flat).toContain('(cur.qfq_close - prev.qfq_close) / prev.qfq_close * 100');
    // 价格取自 raw.daily_quote（不是 daily_indicator 指标表）
    expect(flat).toContain('FROM raw.daily_quote cur');
    expect(flat).toContain('FROM raw.daily_quote');
    // 主查询行别名 i 对齐
    expect(flat).toContain('cur.ts_code = i.ts_code');
    expect(flat).toContain('cur.trade_date = i.trade_date');
    // 比较运算
    expect(flat).toContain('> $1');
    expect(params).toEqual([5]);
  });

  it('A 股 roc gte 0 → 用 >= 操作符', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc', operator: 'gte', value: 0 }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('>= $1');
    expect(params).toEqual([0]);
  });

  // ── crypto ROC SQL 结构 ────────────────────────────────────────────────────────

  it('crypto roc gt 3 → close 列 + klines + interval=1d 出现至少 2 次（cur 外层 + prev 内层）', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc', operator: 'gt', value: 3 }];
    const { sql, params } = builder.buildCryptoQuery(conditions);
    const flat = squash(sql);
    // 变化率公式（close 列）
    expect(flat).toContain('(cur.close - prev.close) / prev.close * 100');
    // 价格取自 klines
    expect(flat).toContain('FROM klines cur');
    // 主查询行别名 k 对齐
    expect(flat).toContain('cur.symbol = k.symbol');
    expect(flat).toContain('cur.open_time = k.open_time');
    // 关键：interval='1d' 必须同时出现在 cur 外层 WHERE 与 prev LATERAL 内层 WHERE
    const intervalCount = (flat.match(/interval = '1d'/g) || []).length;
    expect(intervalCount).toBeGreaterThanOrEqual(2);
    expect(flat).toContain('> $1');
    expect(params).toEqual([3]);
  });

  // ── 不支持的操作符 ─────────────────────────────────────────────────────────────

  it('ROC 上穿 cross_above → warn+skip，单条件 sql 为 FALSE（fail-closed）', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'cross_above', value: 0 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ROC 下穿 cross_below → warn+skip，单条件 sql 为 FALSE（fail-closed）', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'cross_below', value: 0 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ROC 未知操作符 → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'weird' as StrategyConditionItem['operator'], value: 1 },
    ];
    const { sql } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(warnSpy).toHaveBeenCalled();
  });

  // ── 多条件 AND 组合 ───────────────────────────────────────────────────────────

  it('多条件 AND：roc gt 5 + kdj_j gt 20 → 两段 AND 连接，占位编号对齐', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', value: 5, rocParams: { n: 20 } },
      { field: 'kdj_j', operator: 'gt', value: 20 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain(' AND ');
    // ROC 子查询用 $1，kdj_j 用 $2
    expect(flat).toContain('> $1');
    expect(flat).toContain('i.kdj_j > $2');
    expect(params).toEqual([5, 20]);
  });

  // ── compareField（字段对字段）模式 ─────────────────────────────────────────────

  it('ROC 字段对字段：roc gt ma5 → 右侧为 i.ma5 列，无新增 param', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', compareField: 'ma5', compareMode: 'field' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('> i.ma5');
    expect(params).toEqual([]);
  });

  // ── 非法值防御 ─────────────────────────────────────────────────────────────────

  it('ROC 比较值非法（undefined）→ warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', value: undefined },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ROC 比较值非法（NaN）→ warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'roc', operator: 'gt', value: NaN }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ROC 未知 compareField → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'roc', operator: 'gt', compareField: '不存在的字段', compareMode: 'field' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
