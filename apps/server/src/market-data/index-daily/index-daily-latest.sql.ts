/**
 * index-daily getLatest 的 SQL builder:按 category 裁剪 JOIN / LATERAL / CTE。
 *
 * 背景:原 getLatest 对所有 category 无条件 JOIN 5 张 money_flow + 5 个 LATERAL,
 * category='sw' 时实测 mf_sec/mf_ths/mf_mkt/mf_idx 与 sec_roll/ths_roll/idx_roll
 * 纯空跑(rows=0),放大并行负载与 JIT 成本(377 functions)。本 builder 按 category
 * 只拼需要的片段,行为与原版逐位等价(DB 实测验证,见 equiv.spec.ts)。
 *
 * 参照 a-shares-query.sql.ts 的 { sql, params } 纯字符串范式(可单测)。
 *
 * 等价性依据(DB 实测):
 * - money_flow_index 仅含 8 个 market 代码,与 sw/industry/concept 代码域 0 交集
 *   → industry/concept 的 buy*(原 ELSE→mf_idx)恒 null,裁 mf_idx 后仍 null。
 * - sw_member_count(smc)对非 sw 匹配=0 → 非 sw 裁 smc 对 count 零影响(=c.count)。
 * - market 的 netAmount/buy* 走 mf_mkt(非 mf_idx)→ mf_idx 全路径 dead weight。
 *
 * 参数位置(与原 getLatest 一致,裁剪均静态 JOIN,不引入新占位符):
 *   rows:  $1=category  $2=q  $3=pageSize  $4=offset  $5=swTsCodes(仅 sw 命中)
 *   count: $1=category  $2=q  $3=swTsCodes(仅 sw 命中)
 */

export type LatestCategory = 'sw' | 'industry' | 'concept' | 'market';

export interface BuildLatestSqlInput {
  /** null = 混合全部四类(保留原 CASE 结构,仅裁 dead-weight mf_idx/idx_roll) */
  category: LatestCategory | null;
  /** category === 'sw'(预解析,避免 builder 重复推断) */
  isSw: boolean;
  /** isSw 时由 sw_index_catalog 预查的 tsCode 集合(可能 null/空) */
  swTsCodes: string[] | null;
  /** isSw 且 catalog 命中 0 个 → AND FALSE 短路(由 service 在 swLevel!=null 空集时也用) */
  swNoMatch: boolean;
  /** name 模糊关键字(null = 不过滤) */
  q: string | null;
  pageSize: number;
  offset: number;
  /** 排序字段是否依赖 LATERAL 滚动净额(net_amount_5d/10d/20d)→ 全量算完再排序 */
  sortUsesLateral: boolean;
  /** 外层 ORDER BY 表达式,如 '"pctChange" DESC NULLS LAST' */
  orderExpr: string;
}

export interface BuiltLatestSql {
  rowsSql: string;
  rowsParams: unknown[];
  countSql: string;
  countParams: unknown[];
}

/** sw 成分股数 CTE(仅 sw / 混合 拼)。 */
const SMC_CTE = `WITH sw_member_count AS (
         SELECT idx_code, COUNT(DISTINCT ts_code) AS cnt
         FROM (
           SELECT l1_code AS idx_code, ts_code FROM raw.index_member WHERE is_new = 'Y' AND l1_code IS NOT NULL
           UNION ALL
           SELECT l2_code AS idx_code, ts_code FROM raw.index_member WHERE is_new = 'Y' AND l2_code IS NOT NULL
           UNION ALL
           SELECT l3_code AS idx_code, ts_code FROM raw.index_member WHERE is_new = 'Y' AND l3_code IS NOT NULL
         ) u
         GROUP BY idx_code
       )`;

/** 5/10/20 日滚动净额 LATERAL 片段(whereCond 不含 WHERE 关键字)。 */
function rollLateral(alias: string, table: string, whereCond: string): string {
  return `       LEFT JOIN LATERAL (
         SELECT SUM(net_amount) FILTER (WHERE rn <= 5)  AS n5,
                SUM(net_amount) FILTER (WHERE rn <= 10) AS n10,
                SUM(net_amount) FILTER (WHERE rn <= 20) AS n20
         FROM (
           SELECT net_amount, ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn
           FROM ${table}
           WHERE ${whereCond}
           ORDER BY trade_date DESC
           LIMIT 20
         ) t
       ) ${alias} ON TRUE`;
}

/** 明确 category 的裁剪配置。 */
interface ExactCat {
  mfAlias: string;        // 当日资金流表别名(mf_ind/mf_ths/mf_sec/mf_mkt)
  mfTable: string;
  mfCond: string;         // 当日 mf JOIN 条件(不含 ON)
  rollAlias: string;      // 滚动净额 LATERAL 别名(ind_roll/ths_roll/sec_roll/mkt_roll)
  rollTable: string;
  rollWhere: string;      // LATERAL 内 WHERE 条件(market 无 ts_code)
  nameCol: string;        // SELECT name 列源(sw→s.name,其它→c.name)
  countExpr: string;      // SELECT count 列源(sw→smc.cnt,其它→c.count)
  catalogJoin: string;    // 主查询 catalog JOIN(sw→s,其它→c)
  withCte: boolean;       // 是否拼 sw_member_count(sw 需要 smc.cnt)
  /** buy* 当日值来源:sw/market→当日 mf;industry/concept→NULL(原 ELSE→mf_idx 恒空) */
  buyFromMf: boolean;
}

const TS_DATE_COND = 'ts_code = latest."tsCode" AND trade_date <= latest."tradeDate"';

const EXACT_CAT: Record<LatestCategory, ExactCat> = {
  sw: {
    mfAlias: 'mf_ind', mfTable: 'money_flow_industries',
    mfCond: 'mf_ind.ts_code = q.ts_code AND mf_ind.trade_date = q.trade_date',
    rollAlias: 'ind_roll', rollTable: 'money_flow_industries', rollWhere: TS_DATE_COND,
    nameCol: 's.name', countExpr: 'smc.cnt',
    catalogJoin: 'LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code',
    withCte: true, buyFromMf: true,
  },
  industry: {
    mfAlias: 'mf_ths', mfTable: 'money_flow_ths_industries',
    mfCond: 'mf_ths.ts_code = q.ts_code AND mf_ths.trade_date = q.trade_date',
    rollAlias: 'ths_roll', rollTable: 'money_flow_ths_industries', rollWhere: TS_DATE_COND,
    nameCol: 'c.name', countExpr: 'c.count',
    catalogJoin: 'LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code',
    withCte: false, buyFromMf: false,
  },
  concept: {
    mfAlias: 'mf_sec', mfTable: 'money_flow_sectors',
    mfCond: 'mf_sec.ts_code = q.ts_code AND mf_sec.trade_date = q.trade_date',
    rollAlias: 'sec_roll', rollTable: 'money_flow_sectors', rollWhere: TS_DATE_COND,
    nameCol: 'c.name', countExpr: 'c.count',
    catalogJoin: 'LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code',
    withCte: false, buyFromMf: false,
  },
  market: {
    mfAlias: 'mf_mkt', mfTable: 'money_flow_market',
    mfCond: 'mf_mkt.trade_date = q.trade_date',
    rollAlias: 'mkt_roll', rollTable: 'money_flow_market',
    rollWhere: 'trade_date <= latest."tradeDate"',
    nameCol: 'c.name', countExpr: 'c.count',
    catalogJoin: 'LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code',
    withCte: false, buyFromMf: true,
  },
};

/** nameClause 的列源(sw 走 s.name,含混合在内的非 sw 走 c.name,与原 service line 159 一致)。 */
function nameClauseCol(isSw: boolean): string {
  return isSw ? 's.name' : 'c.name';
}

/** 当日 buy* 表达式(buyFromMf 时取当日 mf,否则 NULL::numeric)。 */
function buyExpr(cat: ExactCat, col: 'buy_lg_amount' | 'buy_md_amount' | 'buy_sm_amount'): string {
  return cat.buyFromMf ? `${cat.mfAlias}.${col}` : 'NULL::numeric';
}

/**
 * 按 category 拼装 rows / count SQL。详见文件顶部等价性依据。
 */
export function buildLatestSql(input: BuildLatestSqlInput): BuiltLatestSql {
  const { category, isSw, swTsCodes, swNoMatch, sortUsesLateral, orderExpr } = input;
  const isMixed = category === null;
  const tsCodesActive = isSw && !!swTsCodes && swTsCodes.length > 0;

  const whereCore =
    `($1::text IS NULL OR q.category = $1) AND ($2::text IS NULL OR ${nameClauseCol(isSw)} ILIKE '%' || $2 || '%')`;
  const tsClauseRows = tsCodesActive
    ? ' AND q.ts_code = ANY($5::text[])'
    : swNoMatch ? ' AND FALSE' : '';
  const tsClauseCount = tsCodesActive
    ? ' AND q.ts_code = ANY($3::text[])'
    : swNoMatch ? ' AND FALSE' : '';

  const rowsParams: unknown[] = [category, input.q, input.pageSize, input.offset];
  const countParams: unknown[] = [category, input.q];
  if (tsCodesActive) {
    rowsParams.push(swTsCodes as string[]);
    countParams.push(swTsCodes as string[]);
  }

  const latestFromSql = sortUsesLateral
    ? `(
       ${buildInnerDistinct(input, whereCore, tsClauseRows, isMixed)}
       ) latest`
    : `(
       SELECT * FROM (
       ${buildInnerDistinct(input, whereCore, tsClauseRows, isMixed)}
       ) page
       ORDER BY ${orderExpr}
       LIMIT $3 OFFSET $4
       ) latest`;

  const { lateralSelect, lateralJoins } = buildLateral(input, isMixed);
  const ctePrefix = (isMixed || (isSw && EXACT_CAT.sw.withCte)) ? `${SMC_CTE}\n` : '';

  const rowsSql = `${ctePrefix}SELECT latest.*,${lateralSelect}
       FROM ${latestFromSql}
${lateralJoins}
       ORDER BY ${orderExpr}${sortUsesLateral ? '\n       LIMIT $3 OFFSET $4' : ''}`;

  const countSql = `SELECT COUNT(DISTINCT q.ts_code)::text AS total
         FROM index_daily_quotes q
         ${isMixed ? 'LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code' : EXACT_CAT[category as LatestCategory].catalogJoin}
        WHERE ${whereCore}${tsClauseCount}`;

  return { rowsSql, rowsParams, countSql, countParams };
}

/** 内层 DISTINCT ON (q.ts_code) 子查询。 */
function buildInnerDistinct(
  input: BuildLatestSqlInput,
  whereCore: string,
  tsClauseRows: string,
  isMixed: boolean,
): string {
  if (isMixed) return buildInnerMixed(whereCore, tsClauseRows);
  const cat = EXACT_CAT[input.category as LatestCategory];
  const smcJoin = cat.withCte ? `\n         LEFT JOIN sw_member_count smc ON smc.idx_code = q.ts_code` : '';
  return `         SELECT DISTINCT ON (q.ts_code)
           q.ts_code AS "tsCode", ${cat.nameCol} AS name, q.category,
           q.trade_date AS "tradeDate", q.close,
           q.pct_change AS "pctChange", q.vol_hand AS "vol",
           q.amount, q.total_mv_wan AS "totalMvWan",
           q.pe, q.pb,
           ${cat.countExpr} AS count,
           ${cat.mfAlias}.net_amount AS "netAmount",
           ${buyExpr(cat, 'buy_lg_amount')} AS "buyLgAmount",
           ${buyExpr(cat, 'buy_md_amount')} AS "buyMdAmount",
           ${buyExpr(cat, 'buy_sm_amount')} AS "buySmAmount"
         FROM index_daily_quotes q
         ${cat.catalogJoin}${smcJoin}
         LEFT JOIN ${cat.mfTable} ${cat.mfAlias} ON ${cat.mfCond}
         WHERE ${whereCore}${tsClauseRows}
         ORDER BY q.ts_code, q.trade_date DESC`;
}

/** 混合(null)路径:保留原 CASE 结构,裁 dead-weight mf_idx。 */
function buildInnerMixed(whereCore: string, tsClauseRows: string): string {
  return `         SELECT DISTINCT ON (q.ts_code)
           q.ts_code AS "tsCode", COALESCE(c.name, s.name) AS name, q.category,
           q.trade_date AS "tradeDate", q.close,
           q.pct_change AS "pctChange", q.vol_hand AS "vol",
           q.amount, q.total_mv_wan AS "totalMvWan",
           q.pe, q.pb,
           COALESCE(c.count, smc.cnt) AS count,
           CASE q.category
             WHEN 'sw'       THEN mf_ind.net_amount
             WHEN 'industry' THEN mf_ths.net_amount
             WHEN 'concept'  THEN mf_sec.net_amount
             WHEN 'market'   THEN mf_mkt.net_amount
             ELSE                 COALESCE(mf_ind.net_amount, mf_sec.net_amount, mf_ths.net_amount, mf_mkt.net_amount)
           END AS "netAmount",
           CASE q.category
             WHEN 'market' THEN mf_mkt.buy_lg_amount
             WHEN 'sw'     THEN mf_ind.buy_lg_amount
             ELSE             NULL::numeric
           END AS "buyLgAmount",
           CASE q.category
             WHEN 'market' THEN mf_mkt.buy_md_amount
             WHEN 'sw'     THEN mf_ind.buy_md_amount
             ELSE             NULL::numeric
           END AS "buyMdAmount",
           CASE q.category
             WHEN 'market' THEN mf_mkt.buy_sm_amount
             WHEN 'sw'     THEN mf_ind.buy_sm_amount
             ELSE             NULL::numeric
           END AS "buySmAmount"
         FROM index_daily_quotes q
         LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code
         LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code
         LEFT JOIN sw_member_count smc ON smc.idx_code = q.ts_code
         LEFT JOIN money_flow_industries mf_ind ON mf_ind.ts_code = q.ts_code AND mf_ind.trade_date = q.trade_date
         LEFT JOIN money_flow_sectors mf_sec ON mf_sec.ts_code = q.ts_code AND mf_sec.trade_date = q.trade_date
         LEFT JOIN money_flow_ths_industries mf_ths ON mf_ths.ts_code = q.ts_code AND mf_ths.trade_date = q.trade_date
         LEFT JOIN money_flow_market mf_mkt ON mf_mkt.trade_date = q.trade_date
         WHERE ${whereCore}${tsClauseRows}
         ORDER BY q.ts_code, q.trade_date DESC`;
}

/** 外层滚动净额 SELECT 片段 + LATERAL JOIN 片段。 */
function buildLateral(
  input: BuildLatestSqlInput,
  isMixed: boolean,
): { lateralSelect: string; lateralJoins: string } {
  if (isMixed) {
    const caseExpr = (col: 'n5' | 'n10' | 'n20') =>
      `         CASE latest.category
           WHEN 'sw'       THEN ind_roll.${col}
           WHEN 'industry' THEN ths_roll.${col}
           WHEN 'concept'  THEN sec_roll.${col}
           WHEN 'market'   THEN mkt_roll.${col}
           ELSE COALESCE(ind_roll.${col}, sec_roll.${col}, ths_roll.${col}, mkt_roll.${col})
         END AS "${col === 'n5' ? 'netAmount5d' : col === 'n10' ? 'netAmount10d' : 'netAmount20d'}"`;
    const lateralSelect = `\n${caseExpr('n5')},\n${caseExpr('n10')},\n${caseExpr('n20')}`;
    const lateralJoins = [
      rollLateral('ind_roll', 'money_flow_industries', TS_DATE_COND),
      rollLateral('ths_roll', 'money_flow_ths_industries', TS_DATE_COND),
      rollLateral('sec_roll', 'money_flow_sectors', TS_DATE_COND),
      rollLateral('mkt_roll', 'money_flow_market', 'trade_date <= latest."tradeDate"'),
    ].join('\n');
    return { lateralSelect, lateralJoins };
  }
  const cat = EXACT_CAT[input.category as LatestCategory];
  const lateralSelect =
    `\n         ${cat.rollAlias}.n5 AS "netAmount5d",\n         ${cat.rollAlias}.n10 AS "netAmount10d",\n         ${cat.rollAlias}.n20 AS "netAmount20d"`;
  const lateralJoins = rollLateral(cat.rollAlias, cat.rollTable, cat.rollWhere);
  return { lateralSelect, lateralJoins };
}
