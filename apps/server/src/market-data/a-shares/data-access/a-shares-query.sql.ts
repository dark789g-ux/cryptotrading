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
  roc10: 'i.roc10',
  roc20: 'i.roc20',
  roc60: 'i.roc60',
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

export function buildASharesBaseQuery(
  dto: QueryASharesDto,
  scoreModelVersion?: string | null,
): ASharesQuerySql {
  const params: Array<string | number | string[]> = [];
  let paramIndex = 1;
  const priceMode = dto.priceMode === 'raw' ? 'raw' : 'qfq';
  const priceCols = priceMode === 'raw'
    ? { close: 'q.close', change: 'q.change', pctChg: 'q.pct_chg' }
    : { close: 'q.qfq_close', change: 'q.qfq_change', pctChg: 'q.qfq_pct_chg' };

  // 按「评分」排序时 LEFT JOIN 当日 prod 评分（评分归属 quant 域，此处跨域只读）。
  // - 命中 ml.scores_daily 主键 (trade_date, ts_code, model_version) → 至多一行，不放大 COUNT。
  // - trade_date 对齐前端评分列用的全局最新交易日（= getSummary 的 latestTradeDate），
  //   保证「排序依据」与「展示数值」同源。
  // - model_version 参数置于 WHERE 过滤之前，故占 $1（后续过滤从 $2 起，paramIndex 已递增）。
  let scoreJoin = '';
  if (dto.sort?.field === 'modelScore' && scoreModelVersion) {
    scoreJoin = `
      LEFT JOIN ml.scores_daily sd
        ON sd.ts_code = s.ts_code
        AND sd.trade_date = (SELECT MAX(trade_date) FROM raw.daily_quote)
        AND sd.model_version = $${paramIndex}`;
    params.push(scoreModelVersion);
    paramIndex++;
  }

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
        s.sw_industry_l1_code AS "swIndustryL1Code",
        s.sw_industry_l2_code AS "swIndustryL2Code",
        s.sw_industry_l3_code AS "swIndustryL3Code",
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
        i.ma5 AS "ma5", i.ma30 AS "ma30", i.ma60 AS "ma60", i.ma120 AS "ma120", i.ma240 AS "ma240", i.bbi AS "bbi",
        i.kdj_j AS "kdjJ", i.kdj_k AS "kdjK", i.kdj_d AS "kdjD", i.dif AS "dif", i.dea AS "dea", i.macd AS "macd",
        i.atr_14 AS "atr14", i.loss_atr_14 AS "lossAtr14", i.low_9 AS "low9", i.high_9 AS "high9",
        i.risk_reward_ratio AS "riskRewardRatio", i.stop_loss_pct AS "stopLossPct",
        i.quote_volume_10 AS "quoteVolume10",
        i.brick AS "brick", i.brick_delta AS "brickDelta", i.brick_xg AS "brickXg",
        sa.amv_dif AS "amvDif", sa.amv_dea AS "amvDea", sa.amv_macd AS "amvMacd",
        i.roc10, i.roc20, i.roc60,
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
      LEFT JOIN stock_amv_daily sa ON sa.ts_code = s.ts_code AND sa.trade_date = l.trade_date${scoreJoin}
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

  if (dto.swIndustryL1Code) {
    sql += ` AND s.sw_industry_l1_code = $${paramIndex}`;
    params.push(dto.swIndustryL1Code);
    paramIndex++;
  }

  if (dto.swIndustryL2Code) {
    sql += ` AND s.sw_industry_l2_code = $${paramIndex}`;
    params.push(dto.swIndustryL2Code);
    paramIndex++;
  }

  if (dto.swIndustryL3Code) {
    sql += ` AND s.sw_industry_l3_code = $${paramIndex}`;
    params.push(dto.swIndustryL3Code);
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

  if (dto.indexTsCode) {
    if (dto.indexTsCode.endsWith('.TI')) {
      sql += ` AND s.ts_code IN (SELECT tms.con_code FROM ths_member_stocks tms WHERE tms.ts_code = $${paramIndex})`;
      params.push(dto.indexTsCode);
      paramIndex++;
    } else if (dto.indexTsCode.endsWith('.SI')) {
      sql += ` AND s.ts_code IN (
        SELECT im.ts_code
        FROM raw.index_member im
        WHERE im.l3_code = $${paramIndex}
          AND im.in_date <= l.trade_date
          AND (im.out_date IS NULL OR im.out_date >= l.trade_date)
      )`;
      params.push(dto.indexTsCode);
      paramIndex++;
    }
  }

  return { sql, params, nextParamIndex: paramIndex };
}

export function appendASharesSort(
  sql: string,
  dto: QueryASharesDto,
  hasScoreJoin = false,
): string {
  const sortField = dto.sort?.field ?? 'tsCode';
  const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;
  const dir = sortAsc ? 'ASC' : 'DESC';
  // 评分排序：未评分(NULL)恒置末尾；ts_code 作稳定次序，避免同分/全 NULL 时翻页抖动。
  // 仅在 JOIN 真实存在时走 sd.score（无 prod 模型则降级为默认排序，列本就全 —）。
  if (sortField === 'modelScore' && hasScoreJoin) {
    return `${sql} ORDER BY sd.score ${dir} NULLS LAST, s.ts_code ASC`;
  }
  const sortCol = (dto.priceMode === 'raw' ? RAW_SORT_COL_MAP : QFQ_SORT_COL_MAP)[sortField] ?? 's.ts_code';
  return `${sql} ORDER BY ${sortCol} ${dir} NULLS LAST`;
}
