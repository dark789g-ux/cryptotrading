import { UsStockQueryBody, QueryConditionOp } from '../us-stocks.types';

const OP_MAP: Record<QueryConditionOp, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

/**
 * 高级数值筛选字段 → 列映射白名单（CLAUDE.md：动态字段名禁直接拼接，须经映射）。
 * raw 口径用原始价列；qfq 口径覆盖价格列为 qfq_*。指标列两口径共用（指标基于 qfq 算）。
 */
const RAW_CONDITION_COL_MAP: Record<string, string> = {
  open: 'q.open',
  high: 'q.high',
  low: 'q.low',
  close: 'q.close',
  pctChg: 'q.pct_chg',
  volume: 'q.volume',
  ma5: 'i.ma5',
  ma30: 'i.ma30',
  ma60: 'i.ma60',
  ma120: 'i.ma120',
  ma240: 'i.ma240',
  bbi: 'i.bbi',
  kdjK: 'i.kdj_k',
  kdjD: 'i.kdj_d',
  kdjJ: 'i.kdj_j',
  dif: 'i.dif',
  dea: 'i.dea',
  macd: 'i.macd',
  atr14: 'i.atr_14',
  low9: 'i.low_9',
  high9: 'i.high_9',
  stopLossPct: 'i.stop_loss_pct',
  riskRewardRatio: 'i.risk_reward_ratio',
};

const QFQ_CONDITION_COL_MAP: Record<string, string> = {
  ...RAW_CONDITION_COL_MAP,
  open: 'q.qfq_open',
  high: 'q.qfq_high',
  low: 'q.qfq_low',
  close: 'q.qfq_close',
  pctChg: 'q.qfq_pct_chg',
};

const RAW_SORT_COL_MAP: Record<string, string> = {
  ticker: 's.ticker',
  name: 's.name',
  theme: 's.theme',
  stockType: 's.stock_type',
  close: 'q.close',
  pctChg: 'q.pct_chg',
  volume: 'q.volume',
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
  low9: 'i.low_9',
  high9: 'i.high_9',
  riskRewardRatio: 'i.risk_reward_ratio',
  stopLossPct: 'i.stop_loss_pct',
};

const QFQ_SORT_COL_MAP: Record<string, string> = {
  ...RAW_SORT_COL_MAP,
  close: 'q.qfq_close',
  pctChg: 'q.qfq_pct_chg',
};

export interface UsStockQuerySql {
  sql: string;
  params: Array<string | number>;
  nextParamIndex: number;
}

/**
 * 构造美股查询主 SQL（不含 LIMIT/OFFSET，由调用方追加）。
 *
 * - 每只 tracked 标的取其最新交易日（latest CTE 按 ticker GROUP BY MAX(trade_date)）。
 * - JOIN raw.us_daily_quote + raw.us_daily_indicator（ticker + trade_date）。
 * - priceMode='qfq' 选 qfq_*，'raw' 选原始价列。
 */
export function buildUsStocksBaseQuery(dto: UsStockQueryBody): UsStockQuerySql {
  const params: Array<string | number> = [];
  let paramIndex = 1;
  const priceMode = dto.priceMode === 'raw' ? 'raw' : 'qfq';
  const priceCols =
    priceMode === 'raw'
      ? { close: 'q.close', pctChg: 'q.pct_chg' }
      : { close: 'q.qfq_close', pctChg: 'q.qfq_pct_chg' };

  let sql = `
      WITH latest AS (
        SELECT ticker, MAX(trade_date) AS trade_date
        FROM raw.us_daily_quote
        GROUP BY ticker
      )
      SELECT
        s.ticker AS "ticker",
        s.name AS "name",
        s.theme AS "theme",
        s.stock_type AS "stockType",
        ${priceCols.close} AS close,
        ${priceCols.pctChg} AS "pctChg",
        q.volume AS "volume",
        q.trade_date AS "tradeDate",
        i.ma5 AS "ma5", i.ma30 AS "ma30", i.ma60 AS "ma60", i.ma120 AS "ma120", i.ma240 AS "ma240",
        i.bbi AS "bbi",
        i.kdj_j AS "kdjJ", i.kdj_k AS "kdjK", i.kdj_d AS "kdjD",
        i.dif AS "dif", i.dea AS "dea", i.macd AS "macd",
        i.atr_14 AS "atr14", i.low_9 AS "low9", i.high_9 AS "high9",
        i.risk_reward_ratio AS "riskRewardRatio", i.stop_loss_pct AS "stopLossPct"
      FROM raw.us_symbol s
      LEFT JOIN latest l ON l.ticker = s.ticker
      LEFT JOIN raw.us_daily_quote q ON q.ticker = s.ticker AND q.trade_date = l.trade_date
      LEFT JOIN raw.us_daily_indicator i ON i.ticker = s.ticker AND i.trade_date = l.trade_date
      WHERE s.tracked = true
    `;

  if (dto.q?.trim()) {
    sql += ` AND (s.ticker ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`;
    params.push(`%${dto.q.trim()}%`);
    paramIndex++;
  }

  if (dto.theme) {
    sql += ` AND s.theme = $${paramIndex}`;
    params.push(dto.theme);
    paramIndex++;
  }

  if (dto.stockType) {
    sql += ` AND s.stock_type = $${paramIndex}`;
    params.push(dto.stockType);
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

export function appendUsStocksSort(sql: string, dto: UsStockQueryBody): string {
  const sortField = dto.sort?.field ?? 'ticker';
  const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;
  const dir = sortAsc ? 'ASC' : 'DESC';
  const sortCol = (dto.priceMode === 'raw' ? RAW_SORT_COL_MAP : QFQ_SORT_COL_MAP)[sortField] ?? 's.ticker';
  return `${sql} ORDER BY ${sortCol} ${dir} NULLS LAST, s.ticker ASC`;
}
