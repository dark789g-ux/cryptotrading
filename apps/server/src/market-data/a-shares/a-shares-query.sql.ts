import { QueryASharesDto, QueryCondition } from './a-shares.types';

const OP_MAP: Record<QueryCondition['op'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

const CONDITION_COL_MAP: Record<string, string> = {
  close: 'q.close',
  pctChg: 'q.pct_chg',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  volumeRatio: 'm.volume_ratio',
  pe: 'm.pe',
  pb: 'm.pb',
};

const SORT_COL_MAP: Record<string, string> = {
  tsCode: 's.ts_code',
  symbol: 's.symbol',
  name: 's.name',
  market: 's.market',
  industry: 's.industry',
  close: 'q.close',
  pctChg: 'q.pct_chg',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  pe: 'm.pe',
  pb: 'm.pb',
  tradeDate: 'q.trade_date',
};

export interface ASharesQuerySql {
  sql: string;
  params: Array<string | number>;
  nextParamIndex: number;
}

export function buildASharesBaseQuery(dto: QueryASharesDto): ASharesQuerySql {
  const params: Array<string | number> = [];
  let paramIndex = 1;
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
        q.close,
        q.pct_chg AS "pctChg",
        q.amount,
        m.turnover_rate AS "turnoverRate",
        m.volume_ratio AS "volumeRatio",
        m.pe,
        m.pb,
        m.total_mv AS "totalMv",
        m.circ_mv AS "circMv",
        q.trade_date AS "tradeDate"
      FROM a_share_symbols s
      LEFT JOIN latest l ON l.ts_code = s.ts_code
      LEFT JOIN a_share_daily_quotes q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
      LEFT JOIN a_share_daily_metrics m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
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
    const column = CONDITION_COL_MAP[condition.field];
    const op = OP_MAP[condition.op];
    if (!column || !op) continue;
    sql += ` AND ${column} ${op} $${paramIndex}`;
    params.push(condition.value);
    paramIndex++;
  }

  return { sql, params, nextParamIndex: paramIndex };
}

export function appendASharesSort(sql: string, dto: QueryASharesDto): string {
  const sortField = dto.sort?.field ?? 'tsCode';
  const sortCol = SORT_COL_MAP[sortField] ?? 's.ts_code';
  const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;
  return `${sql} ORDER BY ${sortCol} ${sortAsc ? 'ASC' : 'DESC'} NULLS LAST`;
}
