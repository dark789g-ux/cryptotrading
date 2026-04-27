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
  params: Array<string | number>;
  nextParamIndex: number;
}

export function buildASharesBaseQuery(dto: QueryASharesDto): ASharesQuerySql {
  const params: Array<string | number> = [];
  let paramIndex = 1;
  const priceMode = dto.priceMode === 'raw' ? 'raw' : 'qfq';
  const priceCols = priceMode === 'raw'
    ? { close: 'q.close', change: 'q.change', pctChg: 'q.pct_chg' }
    : { close: 'q.qfq_close', change: 'q.qfq_change', pctChg: 'q.qfq_pct_chg' };
  let sql = `
      WITH latest AS (
        SELECT ts_code, MAX(trade_date) AS trade_date
        FROM a_share_daily_quotes
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
        q.trade_date AS "tradeDate"
      FROM a_share_symbols s
      LEFT JOIN latest l ON l.ts_code = s.ts_code
      LEFT JOIN a_share_daily_quotes q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
      LEFT JOIN a_share_daily_metrics m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
      LEFT JOIN a_share_daily_indicators i ON i.ts_code = s.ts_code AND i.trade_date = l.trade_date
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

  return { sql, params, nextParamIndex: paramIndex };
}

export function appendASharesSort(sql: string, dto: QueryASharesDto): string {
  const sortField = dto.sort?.field ?? 'tsCode';
  const sortCol = (dto.priceMode === 'raw' ? RAW_SORT_COL_MAP : QFQ_SORT_COL_MAP)[sortField] ?? 's.ts_code';
  const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;
  return `${sql} ORDER BY ${sortCol} ${sortAsc ? 'ASC' : 'DESC'} NULLS LAST`;
}
