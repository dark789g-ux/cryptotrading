import { QueryASharesDto, QueryConditionOp } from '../a-shares.types';
import {
  A_SHARES_LAST_QUOTE_LATERAL,
  A_SHARES_SUSPEND_LATERAL,
  buildStaleAwarePriceSelect,
  buildSuspendSelectAliases,
} from './a-shares-suspend.sql';

const OP_MAP: Record<QueryConditionOp, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

const RAW_CONDITION_COL_MAP: Record<string, string> = {
  open: 'q.open',
  high: 'q.high',
  low: 'q.low',
  close: 'q.close',
  change: 'q.change',
  pctChg: 'q.pct_chg',
  volume: 'q.vol',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  volumeRatio: 'm.volume_ratio',
  pe: 'm.pe',
  peTtm: 'm.pe_ttm',
  pb: 'm.pb',
  DIF: 'i.dif',
  DEA: 'i.dea',
  MACD: 'i.macd',
  'KDJ.K': 'i.kdj_k',
  'KDJ.D': 'i.kdj_d',
  'KDJ.J': 'i.kdj_j',
  BBI: 'i.bbi',
  MA5: 'i.ma5',
  MA30: 'i.ma30',
  MA60: 'i.ma60',
  MA120: 'i.ma120',
  MA240: 'i.ma240',
  roc10: 'i.roc10',
  roc20: 'i.roc20',
  roc60: 'i.roc60',
  netInflow: 'mf.net_inflow',
  netInflow5d: 'mf.net_inflow_5d',
  netInflow10d: 'mf.net_inflow_10d',
  netInflow20d: 'mf.net_inflow_20d',
  buyLgAmount: 'mf.buy_lg_amount',
  buyMdAmount: 'mf.buy_md_amount',
  buySmAmount: 'mf.buy_sm_amount',
  obv5d: 'i.obv5d',
  obv10d: 'i.obv10d',
  obv20d: 'i.obv20d',
  VWAP5: 'i.vwap5',
  VWAP10: 'i.vwap10',
  VWAP20: 'i.vwap20',
};

const QFQ_CONDITION_COL_MAP: Record<string, string> = {
  ...RAW_CONDITION_COL_MAP,
  open: 'q.qfq_open',
  high: 'q.qfq_high',
  low: 'q.qfq_low',
  close: 'q.qfq_close',
  change: 'q.qfq_change',
  pctChg: 'q.qfq_pct_chg',
};

const RAW_SORT_COL_MAP: Record<string, string> = {
  tsCode: 's.ts_code',
  symbol: 's.symbol',
  name: 's.name',
  market: 's.market',
  swIndustryL1Code: 's.sw_industry_l1_code',
  swIndustryL2Code: 's.sw_industry_l2_code',
  swIndustryL3Code: 's.sw_industry_l3_code',
  close: 'q.close',
  change: 'q.change',
  pctChg: 'q.pct_chg',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  pe: 'm.pe',
  peTtm: 'm.pe_ttm',
  pb: 'm.pb',
  totalMv: 'm.total_mv',
  circMv: 'm.circ_mv',
  tradeDate: 'q.trade_date',
  ma5: 'i.ma5',
  ma30: 'i.ma30',
  ma60: 'i.ma60',
  ma120: 'i.ma120',
  ma240: 'i.ma240',
  bbi: 'i.bbi',
  kdjJ: 'i.kdj_j',
  kdjK: 'i.kdj_k',
  kdjD: 'i.kdj_d',
  dif: 'i.dif',
  dea: 'i.dea',
  macd: 'i.macd',
  atr14: 'i.atr_14',
  lossAtr14: 'i.loss_atr_14',
  low9: 'i.low_9',
  high9: 'i.high_9',
  riskRewardRatio: 'i.risk_reward_ratio',
  stopLossPct: 'i.stop_loss_pct',
  quoteVolume10: 'i.quote_volume_10',
  brick: 'i.brick',
  brickDelta: 'i.brick_delta',
  brickXg: 'i.brick_xg',
  amvDif: 'sa.amv_dif',
  amvDea: 'sa.amv_dea',
  amvMacd: 'sa.amv_macd',
  roc10: 'i.roc10',
  roc20: 'i.roc20',
  roc60: 'i.roc60',
  netInflow: 'mf.net_inflow',
  netInflow5d: 'mf.net_inflow_5d',
  netInflow10d: 'mf.net_inflow_10d',
  netInflow20d: 'mf.net_inflow_20d',
  buyLgAmount: 'mf.buy_lg_amount',
  buyMdAmount: 'mf.buy_md_amount',
  buySmAmount: 'mf.buy_sm_amount',
  obv5d: 'i.obv5d',
  obv10d: 'i.obv10d',
  obv20d: 'i.obv20d',
  vwap5: 'i.vwap5',
  vwap10: 'i.vwap10',
  vwap20: 'i.vwap20',
};

const QFQ_SORT_COL_MAP: Record<string, string> = {
  ...RAW_SORT_COL_MAP,
  close: 'q.qfq_close',
  change: 'q.qfq_change',
  pctChg: 'q.qfq_pct_chg',
};

const MONEY_FLOW_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT
          SUM(mf.net_amount) FILTER (WHERE dq.rn = 1)  AS net_inflow,
          SUM(mf.net_amount) FILTER (WHERE dq.rn <= 5)  AS net_inflow_5d,
          SUM(mf.net_amount) FILTER (WHERE dq.rn <= 10) AS net_inflow_10d,
          SUM(mf.net_amount)                            AS net_inflow_20d,
          SUM(mf.buy_lg_amount) FILTER (WHERE dq.rn = 1) AS buy_lg_amount,
          SUM(mf.buy_md_amount) FILTER (WHERE dq.rn = 1) AS buy_md_amount,
          SUM(mf.buy_sm_amount) FILTER (WHERE dq.rn = 1) AS buy_sm_amount
        FROM (
          SELECT trade_date,
                 ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn
          FROM raw.daily_quote
          WHERE ts_code = s.ts_code AND trade_date <= l.trade_date
          ORDER BY trade_date DESC
          LIMIT 20
        ) dq
        LEFT JOIN money_flow_stocks mf
          ON mf.ts_code = s.ts_code AND mf.trade_date = dq.trade_date
      ) mf ON true`;

export interface ASharesQuerySql {
  sql: string;
  params: Array<string | number | string[]>;
  nextParamIndex: number;
}

interface JoinRequirements {
  latest: boolean;
  quote: boolean;
  basic: boolean;
  indicator: boolean;
  amv: boolean;
  moneyFlow: boolean;
  score: boolean;
}

interface ParamState {
  params: Array<string | number | string[]>;
  paramIndex: number;
}

function applyColJoin(col: string, req: JoinRequirements): void {
  if (col.startsWith('q.')) {
    req.quote = true;
    req.latest = true;
  } else if (col.startsWith('m.')) {
    req.basic = true;
    req.latest = true;
  } else if (col.startsWith('i.')) {
    req.indicator = true;
    req.latest = true;
  } else if (col.startsWith('sa.')) {
    req.amv = true;
    req.latest = true;
  } else if (col.startsWith('mf.')) {
    req.moneyFlow = true;
    req.latest = true;
  }
}

function emptyJoinRequirements(): JoinRequirements {
  return {
    latest: false,
    quote: false,
    basic: false,
    indicator: false,
    amv: false,
    moneyFlow: false,
    score: false,
  };
}

/** 解析筛选/排序所需的最小 JOIN 集合（Phase1 / COUNT 用）。 */
export function resolveJoinRequirements(
  dto: QueryASharesDto,
  scoreModelVersion?: string | null,
  options: { includeSort?: boolean } = {},
): JoinRequirements {
  const req = emptyJoinRequirements();
  const includeSort = options.includeSort ?? true;
  const conditionColMap = dto.priceMode === 'raw' ? RAW_CONDITION_COL_MAP : QFQ_CONDITION_COL_MAP;
  const sortColMap = dto.priceMode === 'raw' ? RAW_SORT_COL_MAP : QFQ_SORT_COL_MAP;

  if (dto.indexTsCode?.endsWith('.SI')) {
    req.latest = true;
  }

  for (const condition of dto.conditions ?? []) {
    const column = conditionColMap[condition.field];
    if (column) applyColJoin(column, req);
    if (condition.valueType === 'field') {
      const compareColumn = conditionColMap[condition.compareField];
      if (compareColumn) applyColJoin(compareColumn, req);
    }
  }

  if (includeSort) {
    const sortField = dto.sort?.field;
    if (sortField === 'modelScore' && scoreModelVersion) {
      req.score = true;
      req.latest = true;
    } else if (sortField) {
      const sortCol = sortColMap[sortField];
      if (sortCol) applyColJoin(sortCol, req);
    }
  }

  return req;
}

function buildScoreJoin(scoreModelVersion: string, state: ParamState): string {
  state.params.push(scoreModelVersion);
  const idx = state.paramIndex++;
  return `
      LEFT JOIN ml.scores_daily sd
        ON sd.ts_code = s.ts_code
        AND sd.trade_date = (SELECT MAX(trade_date) FROM raw.daily_quote)
        AND sd.model_version = $${idx}`;
}

function buildFromClause(
  req: JoinRequirements,
  scoreModelVersion: string | null | undefined,
  state: ParamState,
): string {
  let sql = `
      FROM a_share_symbols s`;
  if (req.latest) {
    sql += `
      CROSS JOIN latest l`;
  }
  if (req.quote) {
    sql += `
      LEFT JOIN raw.daily_quote q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date`;
  }
  if (req.basic) {
    sql += `
      LEFT JOIN raw.daily_basic m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date`;
  }
  if (req.indicator) {
    sql += `
      LEFT JOIN raw.daily_indicator i ON i.ts_code = s.ts_code AND i.trade_date = l.trade_date`;
  }
  if (req.amv) {
    sql += `
      LEFT JOIN stock_amv_daily sa ON sa.ts_code = s.ts_code AND sa.trade_date = l.trade_date`;
  }
  if (req.score && scoreModelVersion) {
    sql += buildScoreJoin(scoreModelVersion, state);
  }
  if (req.moneyFlow) {
    sql += MONEY_FLOW_LATERAL;
  }
  sql += `
      WHERE s.list_status = 'L'`;
  return sql;
}

function appendFilters(sql: string, dto: QueryASharesDto, state: ParamState): string {
  const priceMode = dto.priceMode === 'raw' ? 'raw' : 'qfq';
  const conditionColMap = priceMode === 'raw' ? RAW_CONDITION_COL_MAP : QFQ_CONDITION_COL_MAP;

  if (dto.q?.trim()) {
    sql += ` AND (s.ts_code ILIKE $${state.paramIndex} OR s.symbol ILIKE $${state.paramIndex} OR s.name ILIKE $${state.paramIndex})`;
    state.params.push(`%${dto.q.trim()}%`);
    state.paramIndex++;
  }

  if (dto.market) {
    sql += ` AND s.market = $${state.paramIndex}`;
    state.params.push(dto.market);
    state.paramIndex++;
  }

  if (dto.swIndustryL1Code) {
    sql += ` AND s.sw_industry_l1_code = $${state.paramIndex}`;
    state.params.push(dto.swIndustryL1Code);
    state.paramIndex++;
  }

  if (dto.swIndustryL2Code) {
    sql += ` AND s.sw_industry_l2_code = $${state.paramIndex}`;
    state.params.push(dto.swIndustryL2Code);
    state.paramIndex++;
  }

  if (dto.swIndustryL3Code) {
    sql += ` AND s.sw_industry_l3_code = $${state.paramIndex}`;
    state.params.push(dto.swIndustryL3Code);
    state.paramIndex++;
  }

  for (const condition of (dto.conditions ?? []).slice(0, 10)) {
    const column = conditionColMap[condition.field];
    const op = OP_MAP[condition.op];
    if (!column || !op) continue;
    if (condition.valueType === 'field') {
      const compareColumn = conditionColMap[condition.compareField];
      if (!compareColumn) continue;
      sql += ` AND ${column} ${op} ${compareColumn}`;
    } else {
      sql += ` AND ${column} ${op} $${state.paramIndex}`;
      state.params.push(condition.value);
      state.paramIndex++;
    }
  }

  if (dto.watchlistIds && dto.watchlistIds.length > 0) {
    sql += ` AND s.ts_code IN (SELECT wi2.symbol FROM watchlist_items wi2 WHERE wi2.watchlist_id = ANY($${state.paramIndex}::uuid[]))`;
    state.params.push(dto.watchlistIds);
    state.paramIndex++;
  }

  if (dto.strategyHitIds && dto.strategyHitIds.length > 0) {
    sql += ` AND s.ts_code IN (
      SELECT DISTINCT h.ts_code
      FROM strategy_condition_hits h
      JOIN strategy_condition_runs r ON h.run_id = r.id
      JOIN strategy_conditions c ON c.last_run_id = r.id
      WHERE c.id = ANY($${state.paramIndex}::uuid[])
        AND r.status = 'completed'
    )`;
    state.params.push(dto.strategyHitIds);
    state.paramIndex++;
  }

  if (dto.tsCodes && dto.tsCodes.length > 0) {
    sql += ` AND s.ts_code = ANY($${state.paramIndex}::varchar[])`;
    state.params.push(dto.tsCodes);
    state.paramIndex++;
  }

  if (dto.indexTsCode) {
    if (dto.indexTsCode.endsWith('.TI')) {
      sql += ` AND s.ts_code IN (SELECT tms.con_code FROM ths_member_stocks tms WHERE tms.ts_code = $${state.paramIndex})`;
      state.params.push(dto.indexTsCode);
      state.paramIndex++;
    } else if (dto.indexTsCode.endsWith('.SI')) {
      sql += ` AND s.ts_code IN (
        SELECT im.ts_code
        FROM raw.index_member im
        WHERE (im.l1_code = $${state.paramIndex} OR im.l2_code = $${state.paramIndex} OR im.l3_code = $${state.paramIndex})
          AND im.in_date <= l.trade_date
          AND (im.out_date IS NULL OR im.out_date >= l.trade_date)
      )`;
      state.params.push(dto.indexTsCode);
      state.paramIndex++;
    }
  }

  return sql;
}

function latestCtePrefix(req: JoinRequirements): string {
  if (!req.latest) return '';
  return `
      WITH latest AS (
        SELECT MAX(trade_date) AS trade_date
        FROM raw.daily_quote
      )`;
}

function buildHydrateSelect(dto: QueryASharesDto): string {
  const priceMode = dto.priceMode === 'raw' ? 'raw' : 'qfq';
  const priceCols = buildStaleAwarePriceSelect(priceMode);

  return `
      SELECT
        s.ts_code AS "tsCode",
        s.symbol,
        s.name,
        s.market,
        s.sw_industry_l1_code AS "swIndustryL1Code",
        s.sw_industry_l2_code AS "swIndustryL2Code",
        s.sw_industry_l3_code AS "swIndustryL3Code",
        sw1.name AS "swIndustryL1Name",
        sw2.name AS "swIndustryL2Name",
        sw3.name AS "swIndustryL3Name",
        ${priceCols.close} AS close,
        ${priceCols.change} AS change,
        ${priceCols.pctChg} AS "pctChg",
        q.amount,
        m.turnover_rate AS "turnoverRate",
        m.volume_ratio AS "volumeRatio",
        m.pe,
        m.pe_ttm AS "peTtm",
        m.pb,
        m.total_mv AS "totalMv",
        m.circ_mv AS "circMv",
        ${priceCols.tradeDate} AS "tradeDate",
        i.ma5 AS "ma5", i.ma30 AS "ma30", i.ma60 AS "ma60", i.ma120 AS "ma120", i.ma240 AS "ma240", i.bbi AS "bbi",
        i.kdj_j AS "kdjJ", i.kdj_k AS "kdjK", i.kdj_d AS "kdjD", i.dif AS "dif", i.dea AS "dea", i.macd AS "macd",
        i.atr_14 AS "atr14", i.loss_atr_14 AS "lossAtr14", i.low_9 AS "low9", i.high_9 AS "high9",
        i.risk_reward_ratio AS "riskRewardRatio", i.stop_loss_pct AS "stopLossPct",
        i.quote_volume_10 AS "quoteVolume10",
        i.brick AS "brick", i.brick_delta AS "brickDelta", i.brick_xg AS "brickXg",
        sa.amv_dif AS "amvDif", sa.amv_dea AS "amvDea", sa.amv_macd AS "amvMacd",
        i.roc10, i.roc20, i.roc60,
        i.obv5d AS "obv5d", i.obv10d AS "obv10d", i.obv20d AS "obv20d",
        i.vwap5 AS "vwap5", i.vwap10 AS "vwap10", i.vwap20 AS "vwap20",
        mf.net_inflow      AS "netInflow",
        mf.net_inflow_5d   AS "netInflow5d",
        mf.net_inflow_10d  AS "netInflow10d",
        mf.net_inflow_20d  AS "netInflow20d",
        mf.buy_lg_amount   AS "buyLgAmount",
        mf.buy_md_amount   AS "buyMdAmount",
        mf.buy_sm_amount   AS "buySmAmount",
        COALESCE(
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('id', w.id::text, 'name', w.name))
           FROM watchlist_items wi
           JOIN watchlists w ON w.id = wi.watchlist_id
           WHERE wi.symbol = s.ts_code),
          '[]'::jsonb
        ) AS tags,${buildSuspendSelectAliases()}`;
}

function buildFullHydrateFromClause(state: ParamState): string {
  return `
      FROM a_share_symbols s
      CROSS JOIN latest l
      LEFT JOIN raw.daily_quote q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
      LEFT JOIN raw.daily_basic m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
      LEFT JOIN raw.daily_indicator i ON i.ts_code = s.ts_code AND i.trade_date = l.trade_date
      LEFT JOIN stock_amv_daily sa ON sa.ts_code = s.ts_code AND sa.trade_date = l.trade_date
      LEFT JOIN sw_index_catalog sw1 ON sw1.ts_code = s.sw_industry_l1_code
      LEFT JOIN sw_index_catalog sw2 ON sw2.ts_code = s.sw_industry_l2_code
      LEFT JOIN sw_index_catalog sw3 ON sw3.ts_code = s.sw_industry_l3_code${A_SHARES_SUSPEND_LATERAL}${A_SHARES_LAST_QUOTE_LATERAL}${MONEY_FLOW_LATERAL}
      WHERE s.list_status = 'L'`;
}

/** Phase1：最小 JOIN，仅取当页 ts_code 并排序。 */
export function buildASharesIdSortQuery(
  dto: QueryASharesDto,
  scoreModelVersion?: string | null,
): ASharesQuerySql {
  const state: ParamState = { params: [], paramIndex: 1 };
  const req = resolveJoinRequirements(dto, scoreModelVersion, { includeSort: true });

  let sql = `${latestCtePrefix(req)}
      SELECT s.ts_code AS "tsCode"`;
  sql += buildFromClause(req, scoreModelVersion, state);
  sql = appendFilters(sql, dto, state);

  return { sql, params: state.params, nextParamIndex: state.paramIndex };
}

/** Phase2：对当页 ts_code 水合宽表（含 LATERAL + tags）。 */
export function buildASharesHydrateQuery(
  tsCodes: string[],
  dto: QueryASharesDto,
): ASharesQuerySql {
  const state: ParamState = { params: [tsCodes], paramIndex: 2 };
  let sql = `
      WITH latest AS (
        SELECT MAX(trade_date) AS trade_date
        FROM raw.daily_quote
      )`;
  sql += buildHydrateSelect(dto);
  sql += buildFullHydrateFromClause(state);
  sql += ` AND s.ts_code = ANY($1::varchar[])`;

  return { sql, params: state.params, nextParamIndex: state.paramIndex };
}

/** COUNT：与 Phase1 相同的最小 JOIN（不含排序列 JOIN）。 */
export function buildASharesCountQuery(
  dto: QueryASharesDto,
  scoreModelVersion?: string | null,
): ASharesQuerySql {
  const state: ParamState = { params: [], paramIndex: 1 };
  const req = resolveJoinRequirements(dto, scoreModelVersion, { includeSort: false });

  let inner = `${latestCtePrefix(req)}
      SELECT s.ts_code`;
  inner += buildFromClause(req, scoreModelVersion, state);
  inner = appendFilters(inner, dto, state);

  const sql = `SELECT COUNT(*) FROM (${inner}) sub`;
  return { sql, params: state.params, nextParamIndex: state.paramIndex };
}

/** 完整宽表查询（单阶段，供单测与向后兼容）。 */
export function buildASharesBaseQuery(
  dto: QueryASharesDto,
  scoreModelVersion?: string | null,
): ASharesQuerySql {
  const state: ParamState = { params: [], paramIndex: 1 };

  let scoreJoin = '';
  if (dto.sort?.field === 'modelScore' && scoreModelVersion) {
    scoreJoin = buildScoreJoin(scoreModelVersion, state);
  }

  let sql = `
      WITH latest AS (
        SELECT MAX(trade_date) AS trade_date
        FROM raw.daily_quote
      )`;
  sql += buildHydrateSelect(dto);
  sql += `
      FROM a_share_symbols s
      CROSS JOIN latest l
      LEFT JOIN raw.daily_quote q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
      LEFT JOIN raw.daily_basic m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
      LEFT JOIN raw.daily_indicator i ON i.ts_code = s.ts_code AND i.trade_date = l.trade_date
      LEFT JOIN stock_amv_daily sa ON sa.ts_code = s.ts_code AND sa.trade_date = l.trade_date
      LEFT JOIN sw_index_catalog sw1 ON sw1.ts_code = s.sw_industry_l1_code
      LEFT JOIN sw_index_catalog sw2 ON sw2.ts_code = s.sw_industry_l2_code
      LEFT JOIN sw_index_catalog sw3 ON sw3.ts_code = s.sw_industry_l3_code${scoreJoin}${A_SHARES_SUSPEND_LATERAL}${A_SHARES_LAST_QUOTE_LATERAL}${MONEY_FLOW_LATERAL}
      WHERE s.list_status = 'L'`;

  sql = appendFilters(sql, dto, state);
  return { sql, params: state.params, nextParamIndex: state.paramIndex };
}

export function appendASharesSort(
  sql: string,
  dto: QueryASharesDto,
  hasScoreJoin = false,
): string {
  const sortField = dto.sort?.field ?? 'tsCode';
  const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;
  const dir = sortAsc ? 'ASC' : 'DESC';
  if (sortField === 'modelScore' && hasScoreJoin) {
    return `${sql} ORDER BY sd.score ${dir} NULLS LAST, s.ts_code ASC`;
  }
  const sortCol = (dto.priceMode === 'raw' ? RAW_SORT_COL_MAP : QFQ_SORT_COL_MAP)[sortField] ?? 's.ts_code';
  return `${sql} ORDER BY ${sortCol} ${dir} NULLS LAST`;
}
