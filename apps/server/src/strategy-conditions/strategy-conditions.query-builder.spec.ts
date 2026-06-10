import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 折叠所有空白便于做不受换行/缩进影响的子串断言 */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('StrategyConditionsQueryBuilder — AMV-MACD 字段', () => {
  let builder: StrategyConditionsQueryBuilder;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    builder = new StrategyConditionsQueryBuilder();
    // 静音并捕获 warn，便于断言 warn+skip 路径
    warnSpy = jest
      .spyOn((builder as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('个股 AMV 比常量：amv_dif gt 0 → sa.amv_dif > $1', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'amv_dif', operator: 'gt', value: 0 }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('sa.amv_dif > $1');
    expect(params).toEqual([0]);
  });

  it('个股 AMV 字段对字段：amv_dif gt amv_dea → sa.amv_dif > sa.amv_dea（同表非 i. 前缀字段对字段）', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'amv_dif', operator: 'gt', compareField: 'amv_dea' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(squash(sql)).toContain('sa.amv_dif > sa.amv_dea');
    expect(params).toEqual([]);
  });

  it('行业 AMV 比常量：ind_amv_dif gt 0 → EXISTS 子查询 + ia.amv_dif > $1', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'ind_amv_dif', operator: 'gt', value: 0 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('EXISTS (');
    expect(flat).toContain('ths_member_stocks');
    expect(flat).toContain('industry_amv_daily');
    expect(flat).toContain('mem.con_code = i.ts_code');
    expect(flat).toContain('ia.ts_code = mem.ts_code');
    expect(flat).toContain('ia.trade_date = i.trade_date');
    expect(flat).toContain('ia.amv_dif > $1');
    expect(params).toEqual([0]);
  });

  it('行业 AMV 字段对字段：ind_amv_dif gt ind_amv_dea → EXISTS 内 ia.amv_dif > ia.amv_dea，无新增 param', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'ind_amv_dif', operator: 'gt', compareField: 'ind_amv_dea' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('EXISTS (');
    expect(flat).toContain('ia.amv_dif > ia.amv_dea');
    expect(params).toEqual([]);
  });

  it('行业 AMV 与个股字段混比：ind_amv_dif gt close → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'ind_amv_dif', operator: 'gt', compareField: 'close' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('行业 AMV 上穿：ind_amv_dif cross_above ind_amv_dea → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'ind_amv_dif', operator: 'cross_above', compareField: 'ind_amv_dea' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('crypto 不支持行业字段：ind_amv_dif gt 0 → 未知字段 warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'ind_amv_dif', operator: 'gt', value: 0 },
    ];
    const { sql, params } = builder.buildCryptoQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('大盘 0AMV 比常量：oamv_macd gt 0 → EXISTS 子查询（oamv_daily 按 trade_date 对齐，无成分股 join）+ oa.amv_macd > $1', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'oamv_macd', operator: 'gt', value: 0 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('EXISTS (');
    expect(flat).toContain('FROM oamv_daily oa');
    expect(flat).toContain('oa.trade_date = i.trade_date');
    expect(flat).toContain('oa.amv_macd > $1');
    expect(flat).not.toContain('ths_member_stocks');
    expect(params).toEqual([0]);
  });

  it('大盘 0AMV 字段对字段：oamv_dif gt oamv_dea → EXISTS 内 oa.amv_dif > oa.amv_dea，无新增 param', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'oamv_dif', operator: 'gt', compareField: 'oamv_dea' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('EXISTS (');
    expect(flat).toContain('oa.amv_dif > oa.amv_dea');
    expect(params).toEqual([]);
  });

  it('大盘 0AMV 与个股字段混比：oamv_dif gt close → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'oamv_dif', operator: 'gt', compareField: 'close' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('大盘 0AMV 上穿：oamv_dif cross_above oamv_dea → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'oamv_dif', operator: 'cross_above', compareField: 'oamv_dea' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('crypto 不支持大盘字段：oamv_macd gt 0 → 未知字段 warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'oamv_macd', operator: 'gt', value: 0 },
    ];
    const { sql, params } = builder.buildCryptoQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('混合个股+行业+大盘 value 条件：占位编号与 params 顺序严格对齐（$1/$2/$3，[5,3,0]）', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'amv_dif', operator: 'gt', value: 5 },
      { field: 'ind_amv_dif', operator: 'gt', value: 3 },
      { field: 'oamv_macd', operator: 'gt', value: 0 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('sa.amv_dif > $1');
    expect(flat).toContain('ia.amv_dif > $2');
    expect(flat).toContain('oa.amv_macd > $3');
    expect(params).toEqual([5, 3, 0]);
  });

  it('混合个股+行业 value 条件：占位编号与 params 顺序严格对齐（$1/$2，[5,3]）', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'amv_dif', operator: 'gt', value: 5 },
      { field: 'ind_amv_dif', operator: 'gt', value: 3 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('sa.amv_dif > $1');
    expect(flat).toContain('ia.amv_dif > $2');
    expect(params).toEqual([5, 3]);
  });

  it('个股 AMV 字段选上穿：amv_dif cross_above amv_dea → 非 i. 前缀 warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'amv_dif', operator: 'cross_above', compareField: 'amv_dea' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('多条件全无效：两条未知字段 → 全跳过，sql 为 FALSE，params 空，warn 被调用', () => {
    const conditions: StrategyConditionItem[] = [
      { field: '不存在A', operator: 'gt', value: 1 },
      { field: '不存在B', operator: 'gt', value: 2 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('空 conditions：无条件仍返回 TRUE，params 空（不被 fail-closed 误伤）', () => {
    const { sql, params } = builder.buildAShareQuery([]);
    expect(sql).toBe('TRUE');
    expect(params).toEqual([]);
  });
});

describe('StrategyConditionsQueryBuilder — 上市时长 list_days 字段', () => {
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

  it('list_days gt 365 → a_share_symbols 自包含标量子查询（自然日差）+ $1', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'list_days', operator: 'gt', value: 365 }];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain(
      "(SELECT to_date(i.trade_date, 'YYYYMMDD') - to_date(sym.list_date, 'YYYYMMDD') FROM a_share_symbols sym WHERE sym.ts_code = i.ts_code) > $1",
    );
    expect(params).toEqual([365]);
  });

  it('list_days 上穿：非 i. 前缀字段 → warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'list_days', operator: 'cross_above', compareField: 'ma5' },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('crypto 不支持 list_days：未知字段 warn+skip，sql 为 FALSE', () => {
    const conditions: StrategyConditionItem[] = [{ field: 'list_days', operator: 'gt', value: 365 }];
    const { sql, params } = builder.buildCryptoQuery(conditions);
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('list_days 与个股条件混用：占位编号与 params 顺序对齐', () => {
    const conditions: StrategyConditionItem[] = [
      { field: 'kdj_j', operator: 'lt', value: 0 },
      { field: 'list_days', operator: 'gt', value: 365 },
    ];
    const { sql, params } = builder.buildAShareQuery(conditions);
    const flat = squash(sql);
    expect(flat).toContain('i.kdj_j < $1');
    expect(flat).toContain('sym.ts_code = i.ts_code) > $2');
    expect(params).toEqual([0, 365]);
  });
});
