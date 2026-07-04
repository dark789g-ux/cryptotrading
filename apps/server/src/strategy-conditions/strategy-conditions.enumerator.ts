/**
 * strategy-conditions.enumerator.ts
 *
 * 通用信号枚举 SQL 构造（纯函数）：把买入条件的 WHERE 片段 + 锚定交易日 T + 标的池
 * 拼成枚举查询。从 signal-stats.enumerator.ts 迁出，供 regime-engine / 回测层等复用。
 */

/** 标的池范围。type='list' 时限定 tsCodes；type='all' 全市场。 */
export interface SignalTestUniverse {
  type: 'all' | 'list';
  tsCodes?: string[];
}

/**
 * 把 WHERE 片段 + 锚定日 T + 标的池 拼成枚举 SQL（参数化）。
 * 表结构：daily_indicator i 主锚 + daily_quote/daily_basic/stock_amv_daily/signal_rolling_indicator 左连。
 */
export function buildEnumerateQuery(
  where: { sql: string; params: unknown[] },
  tradeDate: string,
  universe: SignalTestUniverse,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [...where.params];

  const datePh = `$${params.length + 1}`;
  params.push(tradeDate);

  let universeClause = '';
  if (universe.type === 'list') {
    const codes = universe.tsCodes ?? [];
    const codesPh = `$${params.length + 1}`;
    params.push(codes);
    universeClause = `\n         AND i.ts_code = ANY(${codesPh}::text[])`;
  }

  const sql = `
    SELECT i.ts_code AS "tsCode"
      FROM raw.daily_indicator i
      LEFT JOIN raw.daily_quote q
        ON q.ts_code = i.ts_code AND q.trade_date = i.trade_date
      LEFT JOIN raw.daily_basic m
        ON m.ts_code = i.ts_code AND m.trade_date = i.trade_date
      LEFT JOIN stock_amv_daily sa
        ON sa.ts_code = i.ts_code AND sa.trade_date = i.trade_date
      LEFT JOIN signal_rolling_indicator d
        ON d.ts_code = i.ts_code AND d.trade_date = i.trade_date
     WHERE i.trade_date = ${datePh}${universeClause}
       AND ${where.sql}
     ORDER BY i.ts_code
  `;

  return { sql, params };
}
