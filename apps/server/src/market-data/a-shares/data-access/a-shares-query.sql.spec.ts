import { buildASharesBaseQuery, appendASharesSort } from './a-shares-query.sql';
import { QueryASharesDto } from '../a-shares.types';

describe('a-shares-query.sql 评分排序', () => {
  const PROD = 'lgb-lambdarank-v1-20260521-seed42';

  it('按 modelScore 排序 + 有 prod 模型：JOIN scores_daily，model_version 占 $1，ORDER BY sd.score', () => {
    const dto: QueryASharesDto = { sort: { field: 'modelScore', order: 'descend' }, priceMode: 'qfq' };
    const base = buildASharesBaseQuery(dto, PROD);

    expect(base.sql).toContain('LEFT JOIN ml.scores_daily sd');
    expect(base.sql).toContain('sd.trade_date = (SELECT MAX(trade_date) FROM raw.daily_quote)');
    expect(base.sql).toContain('sd.model_version = $1');
    expect(base.params[0]).toBe(PROD);

    const sorted = appendASharesSort(base.sql, dto, true);
    expect(sorted).toContain('ORDER BY sd.score DESC NULLS LAST, s.ts_code ASC');
  });

  it('升序：ORDER BY sd.score ASC NULLS LAST', () => {
    const dto: QueryASharesDto = { sort: { field: 'modelScore', order: 'ascend' } };
    const base = buildASharesBaseQuery(dto, PROD);
    const sorted = appendASharesSort(base.sql, dto, true);
    expect(sorted).toContain('ORDER BY sd.score ASC NULLS LAST, s.ts_code ASC');
  });

  it('param 顺序：评分排序 + market 过滤 → model_version=$1，market=$2', () => {
    const dto: QueryASharesDto = { sort: { field: 'modelScore', order: 'descend' }, market: '主板' };
    const base = buildASharesBaseQuery(dto, PROD);
    expect(base.sql).toContain('sd.model_version = $1');
    expect(base.sql).toContain('AND s.market = $2');
    expect(base.params).toEqual([PROD, '主板']);
    expect(base.nextParamIndex).toBe(3); // LIMIT=$3 / OFFSET=$4
  });

  it('按 modelScore 排序但无 prod 模型(null)：不 JOIN，降级为默认 ts_code 排序', () => {
    const dto: QueryASharesDto = { sort: { field: 'modelScore', order: 'descend' } };
    const base = buildASharesBaseQuery(dto, null);
    expect(base.sql).not.toContain('ml.scores_daily');
    expect(base.params).toEqual([]);

    const sorted = appendASharesSort(base.sql, dto, false);
    expect(sorted).not.toContain('sd.score');
    expect(sorted).toContain('ORDER BY s.ts_code DESC NULLS LAST');
  });

  it('非评分排序不受影响：不 JOIN scores_daily，按价格列排序', () => {
    const dto: QueryASharesDto = { sort: { field: 'pctChg', order: 'descend' }, priceMode: 'qfq' };
    const base = buildASharesBaseQuery(dto, PROD); // 即便传了 prod 也不该 JOIN
    expect(base.sql).not.toContain('ml.scores_daily');
    expect(base.params).toEqual([]);

    const sorted = appendASharesSort(base.sql, dto, false);
    expect(sorted).toContain('ORDER BY q.qfq_pct_chg DESC NULLS LAST');
  });
});
