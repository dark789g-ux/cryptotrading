import { buildLatestSql, BuildLatestSqlInput } from './index-daily-latest.sql';

/** 默认 input,单测按用例覆盖部分字段。 */
function makeInput(overrides: Partial<BuildLatestSqlInput> = {}): BuildLatestSqlInput {
  return {
    category: null,
    isSw: false,
    swTsCodes: null,
    swNoMatch: false,
    q: null,
    pageSize: 20,
    offset: 0,
    sortUsesLateral: false,
    orderExpr: '"pctChange" DESC NULLS LAST',
    ...overrides,
  };
}

/** 统计 SQL 中 LEFT JOIN LATERAL 出现次数。 */
function lateralCount(sql: string): number {
  return (sql.match(/LEFT JOIN LATERAL/g) ?? []).length;
}

describe('buildLatestSql — 明确 category 裁剪', () => {
  it('sw:只拼 mf_ind + ind_roll + sw_index_catalog + smc CTE,裁掉其余 4 表/4 LATERAL', () => {
    const { rowsSql, rowsParams, countSql } = buildLatestSql(
      makeInput({ category: 'sw', isSw: true, swTsCodes: ['850111.SI'] }),
    );

    // 保留
    expect(rowsSql).toContain('money_flow_industries mf_ind');
    expect(rowsSql).toContain('LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code');
    expect(rowsSql).toContain('LEFT JOIN sw_member_count smc');
    expect(rowsSql).toContain('WITH sw_member_count');
    expect(rowsSql).toContain('ind_roll.n5 AS "netAmount5d"');
    expect(rowsSql).toContain('mf_ind.net_amount AS "netAmount"');
    expect(rowsSql).toContain('mf_ind.buy_lg_amount AS "buyLgAmount"');
    expect(rowsSql).toContain('smc.cnt AS count');
    expect(rowsSql).toContain('s.name AS name');
    expect(rowsSql).toContain('q.ts_code = ANY($5::text[])');
    // 裁掉
    expect(rowsSql).not.toContain('money_flow_sectors');
    expect(rowsSql).not.toContain('money_flow_ths_industries');
    expect(rowsSql).not.toContain('money_flow_market');
    expect(rowsSql).not.toContain('money_flow_index');
    expect(rowsSql).not.toContain('ths_index_catalog');
    expect(rowsSql).not.toContain('ths_roll');
    expect(rowsSql).not.toContain('sec_roll');
    expect(rowsSql).not.toContain('mkt_roll');
    expect(rowsSql).not.toContain('idx_roll');
    expect(lateralCount(rowsSql)).toBe(1);

    // params: $1=category $2=q $3=pageSize $4=offset $5=swTsCodes
    expect(rowsParams).toEqual(['sw', null, 20, 0, ['850111.SI']]);

    // count 查询同源:sw 走 sw_index_catalog(供 s.name 过滤),裁 ths_index_catalog
    expect(countSql).toContain('LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code');
    expect(countSql).toContain('ANY($3::text[])');
    expect(countSql).not.toContain('ths_index_catalog');
  });

  it('industry:只拼 mf_ths + ths_roll + ths_index_catalog,buy* 退化 NULL(原 mf_idx 恒空)', () => {
    const { rowsSql, rowsParams, countSql } = buildLatestSql(
      makeInput({ category: 'industry' }),
    );

    expect(rowsSql).toContain('money_flow_ths_industries mf_ths');
    expect(rowsSql).toContain('LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code');
    expect(rowsSql).toContain('ths_roll.n5 AS "netAmount5d"');
    expect(rowsSql).toContain('mf_ths.net_amount AS "netAmount"');
    expect(rowsSql).toContain('NULL::numeric AS "buyLgAmount"');
    expect(rowsSql).toContain('NULL::numeric AS "buyMdAmount"');
    expect(rowsSql).toContain('NULL::numeric AS "buySmAmount"');
    expect(rowsSql).toContain('c.count AS count');
    expect(rowsSql).toContain('c.name AS name');
    // 裁掉
    expect(rowsSql).not.toContain('money_flow_industries');
    expect(rowsSql).not.toContain('money_flow_sectors');
    expect(rowsSql).not.toContain('money_flow_market');
    expect(rowsSql).not.toContain('money_flow_index');
    expect(rowsSql).not.toContain('sw_member_count');
    expect(rowsSql).not.toContain('sw_index_catalog');
    expect(rowsSql).not.toContain('ANY($5');
    expect(lateralCount(rowsSql)).toBe(1);

    expect(rowsParams).toEqual(['industry', null, 20, 0]);
    expect(countSql).toContain('LEFT JOIN ths_index_catalog c');
    expect(countSql).not.toContain('sw_index_catalog');
  });

  it('concept:只拼 mf_sec + sec_roll + ths_index_catalog', () => {
    const { rowsSql } = buildLatestSql(makeInput({ category: 'concept' }));
    expect(rowsSql).toContain('money_flow_sectors mf_sec');
    expect(rowsSql).toContain('sec_roll.n5 AS "netAmount5d"');
    expect(rowsSql).toContain('mf_sec.net_amount AS "netAmount"');
    expect(rowsSql).not.toContain('money_flow_industries');
    expect(rowsSql).not.toContain('money_flow_ths_industries');
    expect(rowsSql).not.toContain('money_flow_index');
    expect(lateralCount(rowsSql)).toBe(1);
  });

  it('market:只拼 mf_mkt(无 ts_code JOIN)+ mkt_roll(无 ts_code 条件)', () => {
    const { rowsSql } = buildLatestSql(makeInput({ category: 'market' }));
    expect(rowsSql).toContain('money_flow_market mf_mkt');
    expect(rowsSql).toContain('mf_mkt.trade_date = q.trade_date');
    expect(rowsSql).not.toContain('mf_mkt.ts_code = q.ts_code');
    expect(rowsSql).toContain('mkt_roll.n5 AS "netAmount5d"');
    expect(rowsSql).toContain('mf_mkt.buy_lg_amount AS "buyLgAmount"');
    // mkt_roll 的 LATERAL WHERE 只按 trade_date
    expect(rowsSql).toMatch(/FROM money_flow_market\s+WHERE trade_date <= latest\."tradeDate"/);
    expect(lateralCount(rowsSql)).toBe(1);
  });
});

describe('buildLatestSql — 混合(null)保留 CASE 结构,裁 dead-weight mf_idx/idx_roll', () => {
  it('混合:4 张 mf + 4 个 LATERAL + c/s/smc + CASE,裁 money_flow_index/idx_roll', () => {
    const { rowsSql, rowsParams, countSql } = buildLatestSql(makeInput({ category: null }));

    expect(rowsSql).toContain('money_flow_industries mf_ind');
    expect(rowsSql).toContain('money_flow_sectors mf_sec');
    expect(rowsSql).toContain('money_flow_ths_industries mf_ths');
    expect(rowsSql).toContain('money_flow_market mf_mkt');
    expect(rowsSql).toContain('COALESCE(c.name, s.name) AS name');
    expect(rowsSql).toContain('COALESCE(c.count, smc.cnt) AS count');
    expect(rowsSql).toContain('WITH sw_member_count');
    expect(rowsSql).toContain('CASE latest.category');
    expect(rowsSql).toContain('COALESCE(mf_ind.net_amount, mf_sec.net_amount, mf_ths.net_amount, mf_mkt.net_amount)');
    // buy* 的 ELSE 退化为 NULL(原 mf_idx 恒空)
    expect(rowsSql).toContain('WHEN ' + "'sw'     THEN mf_ind.buy_lg_amount");
    // 裁掉
    expect(rowsSql).not.toContain('money_flow_index');
    expect(rowsSql).not.toContain('idx_roll');
    expect(lateralCount(rowsSql)).toBe(4);

    expect(rowsParams).toEqual([null, null, 20, 0]);
    // 混合 count 用 ths_index_catalog(nameClause 非 sw 走 c.name)
    expect(countSql).toContain('LEFT JOIN ths_index_catalog c');
    expect(countSql).not.toContain('sw_index_catalog');
  });
});

describe('buildLatestSql — sortUsesLateral 与分页位置', () => {
  it('sortUsesLateral=false:LIMIT $3 OFFSET $4 在内层 page 子查询,外层末尾仅 ORDER BY', () => {
    const { rowsSql } = buildLatestSql(makeInput({ category: 'industry', sortUsesLateral: false }));
    expect(rowsSql).toContain(') page');
    // LIMIT 仅出现一次(内层),外层 ORDER BY 后不再追加 LIMIT
    expect((rowsSql.match(/LIMIT \$3 OFFSET \$4/g) ?? []).length).toBe(1);
    expect(rowsSql.trim().endsWith('ORDER BY "pctChange" DESC NULLS LAST')).toBe(true);
  });

  it('sortUsesLateral=true:latest 不先分页(无 page 子查询),外层末尾追加 LIMIT $3 OFFSET $4', () => {
    const { rowsSql } = buildLatestSql(
      makeInput({ category: 'industry', sortUsesLateral: true, orderExpr: '"netAmount5d" DESC NULLS LAST' }),
    );
    expect(rowsSql).not.toContain(') page');
    expect(rowsSql.trim().endsWith('LIMIT $3 OFFSET $4')).toBe(true);
  });
});

describe('buildLatestSql — sw 空集短路', () => {
  it('swNoMatch=true:WHERE 追加 AND FALSE,不产生 ANY', () => {
    const { rowsSql, rowsParams } = buildLatestSql(
      makeInput({ category: 'sw', isSw: true, swTsCodes: [], swNoMatch: true }),
    );
    expect(rowsSql).toContain('AND FALSE');
    expect(rowsSql).not.toContain('ANY($5');
    // swTsCodes 空 → 不推入 params
    expect(rowsParams).toEqual(['sw', null, 20, 0]);
  });
});

describe('buildLatestSql — name 搜索与参数注入', () => {
  it('q 非空时占 $2,rowsParams 第二位为 q', () => {
    const { rowsSql, rowsParams } = buildLatestSql(
      makeInput({ category: 'industry', q: '半导' }),
    );
    expect(rowsSql).toContain("ILIKE '%' || $2 || '%'");
    expect(rowsParams[1]).toBe('半导');
  });

  it('sw 的 nameClause 走 s.name,industry 走 c.name', () => {
    const sw = buildLatestSql(makeInput({ category: 'sw', isSw: true, swTsCodes: ['x.SI'] }));
    expect(sw.rowsSql).toContain('$2::text IS NULL OR s.name ILIKE');
    const ind = buildLatestSql(makeInput({ category: 'industry' }));
    expect(ind.rowsSql).toContain('$2::text IS NULL OR c.name ILIKE');
  });
});
