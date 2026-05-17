import { QueryASharesDto, QueryConditionOp } from '../a-shares.types';

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
  industry: 's.industry',
  close: 'q.close',
  change: 'q.change',
  pctChg: 'q.pct_chg',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  pe: 'm.pe',
  peTtm: 'm.pe_ttm',
  pb: 'm.pb',
  tradeDate: 'q.trade_date',
};

const QFQ_SORT_COL_MAP: Record<string, string> = {
  ...RAW_SORT_COL_MAP,
  close: 'q.qfq_close',
  change: 'q.qfq_change',
  pctChg: 'q.qfq_pct_chg',
};

export interface ASharesQuerySql {
  sql: string;
  params: Array<string | number | string[]>;
  nextParamIndex: number;
}

export function buildASharesBaseQuery(dto: QueryASharesDto): ASharesQuerySql {
  const params: Array<string | number | string[]> = [];
  let paramIndex = 1;
  const priceMode = dto.priceMode === 'raw' ? 'raw' : 'qfq';
  const priceCols = priceMode === 'raw'
    ? { close: 'q.close', change: 'q.change', pctChg: 'q.pct_chg' }
    : { close: 'q.qfq_close', change: 'q.qfq_change', pctChg: 'q.qfq_pct_chg' };
  let sql = `
      WITH latest AS (
        SELECT ts_code, MAX(trade_date) AS trade_date
        FROM raw.daily_quote
        GROUP BY ts_code
      )
      SELECT
        s.ts_code AS "tsCode",
        s.symbol,
        s.name,
        s.market,
        s.industry,
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
        q.trade_date AS "tradeDate",
        COALESCE(
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('id', w.id::text, 'name', w.name))
           FROM watchlist_items wi
           JOIN watchlists w ON w.id = wi.watchlist_id
           WHERE wi.symbol = s.ts_code),
          '[]'::jsonb
        ) AS tags
      FROM a_share_symbols s
      LEFT JOIN latest l ON l.ts_code = s.ts_code
      LEFT JOIN raw.daily_quote q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
      LEFT JOIN raw.daily_basic m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
      LEFT JOIN raw.daily_indicator i ON i.ts_code = s.ts_code AND i.trade_date = l.trade_date
      WHERE s.list_status = 'L'
    `;

  if (dto.q?.trim()) {
    sql += ` AND (s.ts_code ILIKE $${paramIndex} OR s.symbol ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`;
    params.push(`%${dto.q.trim()}%`);
    paramIndex++;
  }

  if (dto.market) {
    sql += ` AND s.market = $${paramIndex}`;
    params.push(dto.market);
    paramIndex++;
  }

  if (dto.industry) {
    sql += ` AND s.industry = $${paramIndex}`;
    params.push(dto.industry);
    paramIndex++;
  }

  for (const condition of (dto.conditions ?? []).slice(0, 10)) {
    const conditionColMap = priceMode === 'raw' ? RAW_CONDITION_COL_MAP : QFQ_CONDITION_COL_MAP;
    const column = conditionColMap[condition.field];
    const op = OP_MAP[condition.op];
    if (!column || !op) continue;
    if (condition.valueType === 'field') {
      const compareColumn = conditionColMap[condition.compareField];
      if (!compareColumn) continue;
      sql += ` AND ${column} ${op} ${compareColumn}`;
    } else {
      sql += ` AND ${column} ${op} $${paramIndex}`;
      params.push(condition.value);
      paramIndex++;
    }
  }

  if (dto.watchlistIds && dto.watchlistIds.length > 0) {
    sql += ` AND s.ts_code IN (SELECT wi2.symbol FROM watchlist_items wi2 WHERE wi2.watchlist_id = ANY($${paramIndex}::uuid[]))`;
    params.push(dto.watchlistIds);
    paramIndex++;
  }

  if (dto.strategyHitIds && dto.strategyHitIds.length > 0) {
    sql += ` AND s.ts_code IN (
      SELECT DISTINCT h.ts_code
      FROM strategy_condition_hits h
      JOIN strategy_condition_runs r ON h.run_id = r.id
      JOIN strategy_conditions c ON c.last_run_id = r.id
      WHERE c.id = ANY($${paramIndex}::uuid[])
        AND r.status = 'completed'
    )`;
    params.push(dto.strategyHitIds);
    paramIndex++;
  }

  return { sql, params, nextParamIndex: paramIndex };
}

export function appendASharesSort(sql: string, dto: QueryASharesDto): string {
  const sortField = dto.sort?.field ?? 'tsCode';
  const sortCol = (dto.priceMode === 'raw' ? RAW_SORT_COL_MAP : QFQ_SORT_COL_MAP)[sortField] ?? 's.ts_code';
  const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;
  return `${sql} ORDER BY ${sortCol} ${sortAsc ? 'ASC' : 'DESC'} NULLS LAST`;
}
