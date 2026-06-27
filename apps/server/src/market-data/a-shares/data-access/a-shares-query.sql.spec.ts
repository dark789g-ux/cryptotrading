import { buildASharesBaseQuery, appendASharesSort } from './a-shares-query.sql';
import { QueryASharesDto } from '../a-shares.types';

// 共享辅助：取某字段在指定 priceMode 下解析出的排序列名。
// appendASharesSort 末尾拼 `ORDER BY <col> ASC NULLS LAST`；LATERAL 子查询内的
// `ORDER BY trade_date DESC` 是 DESC，不会被 ASC 正则误匹配。
function sortColFor(field: string, priceMode: 'raw' | 'qfq' = 'qfq'): string {
  const dto: QueryASharesDto = { sort: { field, order: 'ascend' }, priceMode };
  const base = buildASharesBaseQuery(dto);
  const sorted = appendASharesSort(base.sql, dto, false);
  const m = sorted.match(/ORDER BY (.+?) ASC NULLS LAST/);
  return m ? m[1] : '';
}

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

describe('a-shares-query.sql 技术指标 + 个股 AMV 列', () => {
  const PROD = 'lgb-lambdarank-v1-20260521-seed42';
  const baseDto: QueryASharesDto = { priceMode: 'qfq' };

  it('SELECT 补 Tier-1 每股指标列（字面别名精确）', () => {
    const { sql } = buildASharesBaseQuery(baseDto);
    // 均线 / BBI
    expect(sql).toContain('i.ma5 AS "ma5"');
    expect(sql).toContain('i.ma30 AS "ma30"');
    expect(sql).toContain('i.ma60 AS "ma60"');
    expect(sql).toContain('i.ma120 AS "ma120"');
    expect(sql).toContain('i.ma240 AS "ma240"');
    expect(sql).toContain('i.bbi AS "bbi"');
    // KDJ / MACD（snake_case → camelCase 别名）
    expect(sql).toContain('i.kdj_j AS "kdjJ"');
    expect(sql).toContain('i.kdj_k AS "kdjK"');
    expect(sql).toContain('i.kdj_d AS "kdjD"');
    expect(sql).toContain('i.dif AS "dif"');
    expect(sql).toContain('i.dea AS "dea"');
    expect(sql).toContain('i.macd AS "macd"');
    // ATR / 9日高低 / 风险
    expect(sql).toContain('i.atr_14 AS "atr14"');
    expect(sql).toContain('i.loss_atr_14 AS "lossAtr14"');
    expect(sql).toContain('i.low_9 AS "low9"');
    expect(sql).toContain('i.high_9 AS "high9"');
    expect(sql).toContain('i.risk_reward_ratio AS "riskRewardRatio"');
    expect(sql).toContain('i.stop_loss_pct AS "stopLossPct"');
    expect(sql).toContain('i.quote_volume_10 AS "quoteVolume10"');
    // 砖块（brick_xg 为 boolean 列）
    expect(sql).toContain('i.brick AS "brick"');
    expect(sql).toContain('i.brick_delta AS "brickDelta"');
    expect(sql).toContain('i.brick_xg AS "brickXg"');
  });

  it('SELECT 补个股 AMV 列（来自 stock_amv_daily sa）', () => {
    const { sql } = buildASharesBaseQuery(baseDto);
    expect(sql).toContain('sa.amv_dif AS "amvDif"');
    expect(sql).toContain('sa.amv_dea AS "amvDea"');
    expect(sql).toContain('sa.amv_macd AS "amvMacd"');
  });

  it('LEFT JOIN stock_amv_daily（裸名 public 库，不是 raw.，按唯一键不放大行数）', () => {
    const { sql } = buildASharesBaseQuery(baseDto);
    expect(sql).toContain(
      'LEFT JOIN stock_amv_daily sa ON sa.ts_code = s.ts_code AND sa.trade_date = l.trade_date',
    );
    expect(sql).not.toContain('raw.stock_amv_daily');
  });

  it('SELECT 补资金流向四列（来自 LATERAL money_flow_stocks）', () => {
    const { sql } = buildASharesBaseQuery(baseDto);
    expect(sql).toContain('mf.net_inflow      AS "netInflow"');
    expect(sql).toContain('mf.net_inflow_5d   AS "netInflow5d"');
    expect(sql).toContain('mf.net_inflow_10d  AS "netInflow10d"');
    expect(sql).toContain('mf.net_inflow_20d  AS "netInflow20d"');
  });

  it('LEFT JOIN LATERAL money_flow_stocks（逐票最近 20 条，纯 SQL 无参数）', () => {
    const { sql } = buildASharesBaseQuery(baseDto);
    expect(sql).toContain('LEFT JOIN LATERAL (');
    expect(sql).toContain('FROM money_flow_stocks');
    expect(sql).toContain('WHERE ts_code = s.ts_code AND trade_date <= l.trade_date');
    expect(sql).toContain('SUM(t.net_amount) FILTER (WHERE t.rn <= 5)');
    expect(sql).toContain('SUM(t.net_amount) FILTER (WHERE t.rn <= 10)');
    expect(sql).toContain('SUM(t.net_amount)                            AS net_inflow_20d');
    expect(sql).toContain(') mf ON true');
  });

  it('LATERAL JOIN 在 scoreJoin 之后、WHERE 之前', () => {
    const dto: QueryASharesDto = { sort: { field: 'modelScore', order: 'descend' } };
    const { sql } = buildASharesBaseQuery(dto, PROD);
    const scoreJoinIdx = sql.indexOf('LEFT JOIN ml.scores_daily sd');
    const lateralIdx   = sql.indexOf('LEFT JOIN LATERAL (');
    const whereIdx     = sql.indexOf("WHERE s.list_status = 'L'");
    expect(lateralIdx).toBeGreaterThan(scoreJoinIdx);
    expect(lateralIdx).toBeLessThan(whereIdx);
  });

  it('资金流向列排序映射：netInflow / netInflow5d / netInflow10d / netInflow20d', () => {
    expect(sortColFor('netInflow',    'raw')).toBe('mf.net_inflow');
    expect(sortColFor('netInflow5d',  'raw')).toBe('mf.net_inflow_5d');
    expect(sortColFor('netInflow10d', 'raw')).toBe('mf.net_inflow_10d');
    expect(sortColFor('netInflow20d', 'raw')).toBe('mf.net_inflow_20d');
  });

  it('QFQ 模式继承资金流向列排序映射', () => {
    expect(sortColFor('netInflow5d', 'qfq')).toBe('mf.net_inflow_5d');
  });

  it('资金流向列不进入 condition 映射（不能作筛选条件）', () => {
    // netInflow5d 不在 RAW/QFQ_CONDITION_COL_MAP，作 condition 时 conditions 循环
    // 因 column 未命中而 continue：既不拼 WHERE 过滤片段，也不推入参数。
    // 注意：SQL 里本就含 `mf.net_inflow_5d AS "netInflow5d"`（SELECT 别名），
    // 故不能断言整段 SQL 不含该串——要验证的是「没被拼成 AND 过滤条件」。
    const dto: QueryASharesDto = {
      priceMode: 'qfq',
      conditions: [{ field: 'netInflow5d', op: 'gt', value: 100 }],
    };
    const base = buildASharesBaseQuery(dto);
    expect(base.params).toEqual([]); // condition 被跳过，value=100 未推入
    expect(base.sql).not.toContain('AND mf.net_inflow_5d'); // 未拼成 WHERE 过滤片段
  });
});

describe('a-shares-query.sql 指标列排序映射', () => {
  it.each([
    ['ma5', 'i.ma5'],
    ['ma30', 'i.ma30'],
    ['ma60', 'i.ma60'],
    ['ma120', 'i.ma120'],
    ['ma240', 'i.ma240'],
    ['bbi', 'i.bbi'],
    ['kdjJ', 'i.kdj_j'],
    ['kdjK', 'i.kdj_k'],
    ['kdjD', 'i.kdj_d'],
    ['dif', 'i.dif'],
    ['dea', 'i.dea'],
    ['macd', 'i.macd'],
    ['atr14', 'i.atr_14'],
    ['lossAtr14', 'i.loss_atr_14'],
    ['low9', 'i.low_9'],
    ['high9', 'i.high_9'],
    ['riskRewardRatio', 'i.risk_reward_ratio'],
    ['stopLossPct', 'i.stop_loss_pct'],
    ['quoteVolume10', 'i.quote_volume_10'],
    ['brick', 'i.brick'],
    ['brickDelta', 'i.brick_delta'],
    ['brickXg', 'i.brick_xg'],
    ['amvDif', 'sa.amv_dif'],
    ['amvDea', 'sa.amv_dea'],
    ['amvMacd', 'sa.amv_macd'],
  ])('RAW_SORT_COL_MAP 解析 %s → %s', (field, col) => {
    expect(sortColFor(field, 'raw')).toBe(col);
  });

  it('QFQ 模式继承指标列映射（amvMacd / kdjJ 同样可排序）', () => {
    expect(sortColFor('amvMacd', 'qfq')).toBe('sa.amv_macd');
    expect(sortColFor('kdjJ', 'qfq')).toBe('i.kdj_j');
  });

  it('未知排序字段回退 s.ts_code', () => {
    expect(sortColFor('nonexistentField', 'raw')).toBe('s.ts_code');
    expect(sortColFor('nonexistentField', 'qfq')).toBe('s.ts_code');
  });
});

describe('a-shares-query.sql indexTsCode 指数成分股筛选', () => {
  it('.TI 结尾时 SQL 包含 ths_member_stocks 且参数占位符正确', () => {
    const dto: QueryASharesDto = { indexTsCode: '885001.TI' };
    const base = buildASharesBaseQuery(dto);

    expect(base.sql).toContain('ths_member_stocks');
    expect(base.sql).toContain('tms.con_code');
    expect(base.sql).toContain('tms.ts_code = $1');
    expect(base.params).toEqual(['885001.TI']);
    expect(base.nextParamIndex).toBe(2);
  });

  it('.SI 结尾时 SQL 包含 raw.index_member、PIT 条件、且三列 OR 匹配 .SI 后缀', () => {
    const dto: QueryASharesDto = { indexTsCode: '801010.SI' };
    const base = buildASharesBaseQuery(dto);

    expect(base.sql).toContain('raw.index_member');
    expect(base.sql).toContain('(im.l1_code = $1 OR im.l2_code = $1 OR im.l3_code = $1)');
    expect(base.sql).toContain("im.in_date <= l.trade_date");
    expect(base.sql).toContain("im.out_date IS NULL OR im.out_date >= l.trade_date");
    expect(base.params).toEqual(['801010.SI']);
    expect(base.nextParamIndex).toBe(2);
  });

  it('indexTsCode 与 market 同时存在时参数顺序正确', () => {
    const dto: QueryASharesDto = { indexTsCode: '885001.TI', market: '主板' };
    const base = buildASharesBaseQuery(dto);

    // market 先拼接 → $1，ths_member_stocks 后拼接 → $2
    expect(base.sql).toContain('s.market = $1');
    expect(base.sql).toContain('tms.ts_code = $2');
    expect(base.params).toEqual(['主板', '885001.TI']);
    expect(base.nextParamIndex).toBe(3);
  });

  it('indexTsCode 与 swIndustryL1Code + conditions 同时存在时参数顺序正确', () => {
    const dto: QueryASharesDto = {
      indexTsCode: '801010.SI',
      swIndustryL1Code: '801010',
      conditions: [{ field: 'pe', op: 'lt', value: 10 }],
    };
    const base = buildASharesBaseQuery(dto);

    // swIndustryL1Code=$1, pe=$2, l3_code=$3（indexTsCode 最后拼接）
    expect(base.sql).toContain('s.sw_industry_l1_code = $1');
    expect(base.sql).toContain('m.pe < $2');
    expect(base.sql).toContain('(im.l1_code = $3 OR im.l2_code = $3 OR im.l3_code = $3)');
    expect(base.params).toEqual(['801010', 10, '801010.SI']);
    expect(base.nextParamIndex).toBe(4);
  });

  it('无 indexTsCode 时不引入任何指数相关 SQL', () => {
    const dto: QueryASharesDto = { market: '主板' };
    const base = buildASharesBaseQuery(dto);

    expect(base.sql).not.toContain('ths_member_stocks');
    expect(base.sql).not.toContain('raw.index_member');
    expect(base.params).toEqual(['主板']);
  });
});
