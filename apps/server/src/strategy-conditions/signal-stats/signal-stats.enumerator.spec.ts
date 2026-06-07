/**
 * signal-stats.enumerator.spec.ts
 *
 * 信号枚举 SQL 生成单测（不连 DB）：验证
 *   - 锚定到指定交易日 T 的 WHERE 生成正确（i.trade_date=:T 而非 MAX）。
 *   - universe='list' 追加 i.ts_code = ANY(:tsCodes::text[])。
 *   - cross 算子跨日子查询复用 query-builder（锚定日相对取前一交易日）正确。
 *
 * 用真实 StrategyConditionsQueryBuilder（纯逻辑、不依赖 DB）+ 纯函数 buildEnumerateQuery。
 */

import { buildEnumerateQuery } from './signal-stats.enumerator';
import { StrategyConditionsQueryBuilder } from '../strategy-conditions.query-builder';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';

describe('buildEnumerateQuery', () => {
  const qb = new StrategyConditionsQueryBuilder();

  it('简单比较条件：锚定 i.trade_date 用绑定参数（非 MAX 子查询）', () => {
    const conds: StrategyConditionItem[] = [{ field: 'close', operator: 'gt', value: 5 }];
    const where = qb.buildAShareQuery(conds);
    const { sql, params } = buildEnumerateQuery(where, '20260506', { type: 'all' });

    // where.params = [5]，再 push tradeDate → params[1]=tradeDate
    expect(params).toEqual([5, '20260506']);
    // 锚定日用绑定占位符 $2，不出现 MAX(trade_date)
    expect(sql).toContain('WHERE i.trade_date = $2');
    expect(sql).not.toContain('MAX(trade_date)');
    // 主锚表 daily_indicator + 左连 quote/basic/amv（与 runner 一致）
    expect(sql).toContain('FROM raw.daily_indicator i');
    expect(sql).toContain('LEFT JOIN raw.daily_quote q');
    expect(sql).toContain('LEFT JOIN raw.daily_basic m');
    expect(sql).toContain('LEFT JOIN stock_amv_daily sa');
    // close → q.close，绑定到 $1
    expect(sql).toContain('q.close > $1');
  });

  it("universe='list'：追加 i.ts_code = ANY(::text[]) 并绑定 tsCodes", () => {
    const conds: StrategyConditionItem[] = [{ field: 'close', operator: 'gt', value: 5 }];
    const where = qb.buildAShareQuery(conds);
    const tsCodes = ['000001.SZ', '600000.SH'];
    const { sql, params } = buildEnumerateQuery(where, '20260506', {
      type: 'list',
      tsCodes,
    });

    // params: [5(value), 20260506(date), tsCodes]
    expect(params).toEqual([5, '20260506', tsCodes]);
    expect(sql).toContain('AND i.ts_code = ANY($3::text[])');
  });

  it("universe='list' 但 tsCodes 缺省：绑定空数组（不匹配任何标的）", () => {
    const conds: StrategyConditionItem[] = [{ field: 'close', operator: 'gt', value: 5 }];
    const where = qb.buildAShareQuery(conds);
    const { sql, params } = buildEnumerateQuery(where, '20260506', { type: 'list' });
    expect(params[2]).toEqual([]);
    expect(sql).toContain('ANY($3::text[])');
  });

  it('cross_above：跨日子查询复用，锚定日相对取前一交易日', () => {
    // macd_dif(i.dif) cross_above macd_dea(i.dea)
    const conds: StrategyConditionItem[] = [
      { field: 'macd_dif', operator: 'cross_above', compareField: 'macd_dea' },
    ];
    const where = qb.buildAShareQuery(conds);
    const { sql } = buildEnumerateQuery(where, '20260506', { type: 'all' });

    // cross 子查询：prev 取 trade_date < i.trade_date 的 MAX（相对锚定日的前一交易日）
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('FROM raw.daily_indicator prev');
    expect(sql).toContain('MAX(trade_date)');
    expect(sql).toContain('trade_date < i.trade_date');
    // 当日方向：i.dif > i.dea；前日方向 prev.dif < prev.dea
    expect(sql).toContain('i.dif > i.dea');
    expect(sql).toContain('prev.dif < prev.dea');
    // 锚定日仍是绑定参数（cross 不带 value 参数，故占位符是 $1）
    expect(sql).toContain('WHERE i.trade_date = $1');
  });

  it('多条件混合：参数顺序 = where.params 在前、锚定日次之、list 末尾', () => {
    const conds: StrategyConditionItem[] = [
      { field: 'close', operator: 'gt', value: 5 },
      { field: 'turnover_rate', operator: 'lt', value: 10 },
    ];
    const where = qb.buildAShareQuery(conds);
    const { params } = buildEnumerateQuery(where, '20260506', {
      type: 'list',
      tsCodes: ['000001.SZ'],
    });
    // where.params=[5,10]，再 date，再 tsCodes
    expect(params).toEqual([5, 10, '20260506', ['000001.SZ']]);
  });
});
