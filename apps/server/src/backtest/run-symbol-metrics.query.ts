import { KLINE_INDICATOR_COLUMNS, KLINE_OP_MAP } from '../catalog/symbols/symbols.service';
import type { RunSymbolMetricRow, RunSymbolMetricsQueryDto } from './backtest.types';

export const METRICS_SORT_COL_MAP: Record<string, string> = {
  symbol: 'p.symbol',
  close: 'k.close',
  ma5: 'k.ma5',
  ma30: 'k.ma30',
  ma60: 'k.ma60',
  kdjJ: 'k.kdj_j',
  riskRewardRatio: 'k.risk_reward_ratio',
  stopLossPct: 'k.stop_loss_pct',
  dataStatus: '(CASE WHEN k.id IS NULL THEN 1 ELSE 0 END)',
};

function metricNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function metricBool(v: unknown): boolean {
  if (v === true) return true;
  if (v === false) return false;
  return false;
}

export function mapMetricRow(r: Record<string, unknown>): RunSymbolMetricRow {
  const st = r.dataStatus === 'missing' ? 'missing' : 'ok';
  return {
    symbol: String(r.symbol ?? ''),
    dataStatus: st,
    close: metricNum(r.close),
    ma5: metricNum(r.ma5),
    ma30: metricNum(r.ma30),
    ma60: metricNum(r.ma60),
    kdjJ: metricNum(r.kdjJ),
    riskRewardRatio: metricNum(r.riskRewardRatio),
    stopLossPct: metricNum(r.stopLossPct),
    buyOnBar: metricBool(r.buyOnBar),
    sellOnBar: metricBool(r.sellOnBar),
    holdAtClose: metricBool(r.holdAtClose),
  };
}

export function buildRunSymbolMetricsInnerSql(opts: {
  interval: string;
  tsDate: Date;
  pool: string[];
  runId: string;
  dto: RunSymbolMetricsQueryDto;
}): { inner: string; params: unknown[]; nextParamIndex: number } {
  const { interval, tsDate, pool, runId, dto } = opts;

  const onlyBuy = dto.only_buy_on_bar === true;
  const onlySell = dto.only_sell_on_bar === true;
  const onlyOpen = dto.only_open_at_close === true;

  const buyBarPredicate = `(
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(cl.entries_json, '[]'::jsonb)) AS ej
          WHERE ej->>'symbol' = p.symbol
        )
        OR (
          (COALESCE(cl.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol))
          AND NOT (COALESCE(prev.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol))
        )
      )`;
  const sellBarPredicate = `(
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(cl.exits_json, '[]'::jsonb)) AS xj
          WHERE xj->>'symbol' = p.symbol
        )
        OR (
          (COALESCE(prev.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol))
          AND NOT (COALESCE(cl.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol))
        )
      )`;
  const openAtClosePredicate = `COALESCE(cl.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol)`;

  let inner = `
      SELECT
        p.symbol,
        CASE WHEN k.id IS NULL THEN 'missing' ELSE 'ok' END AS "dataStatus",
        k.close AS "close",
        k.ma5 AS "ma5",
        k.ma30 AS "ma30",
        k.ma60 AS "ma60",
        k.kdj_j AS "kdjJ",
        k.risk_reward_ratio AS "riskRewardRatio",
        k.stop_loss_pct AS "stopLossPct",
        ( ${buyBarPredicate} ) AS "buyOnBar",
        ( ${sellBarPredicate} ) AS "sellOnBar",
        ( ${openAtClosePredicate} ) AS "holdAtClose"
      FROM (
        SELECT DISTINCT unnest($3::varchar[]) AS symbol
      ) p
      LEFT JOIN klines k
        ON k.symbol = p.symbol AND k.interval = $1 AND k.open_time = $2::timestamptz`;

  const params: unknown[] = [interval, tsDate, pool];
  let pi = 4;

  inner += `
      LEFT JOIN backtest_candle_logs cl
        ON cl.run_id = $${pi} AND cl.ts = $2::timestamptz`;
  params.push(runId);
  pi += 1;
  inner += `
      LEFT JOIN backtest_candle_logs prev
        ON prev.run_id = cl.run_id AND prev.bar_idx = cl.bar_idx - 1`;

  inner += `
      WHERE 1=1`;

  const q = (dto.q ?? '').trim();
  if (q) {
    inner += ` AND p.symbol ILIKE $${pi}`;
    params.push(`%${q}%`);
    pi++;
  }
  for (const cond of (dto.conditions ?? []).slice(0, 10)) {
    const col = KLINE_INDICATOR_COLUMNS[cond.field];
    const op = KLINE_OP_MAP[cond.op];
    if (!col || !op) continue;
    inner += ` AND k.${col} ${op} $${pi}`;
    params.push(cond.value);
    pi++;
  }

  const statusPreds: string[] = [];
  if (onlyBuy) statusPreds.push(buyBarPredicate);
  if (onlySell) statusPreds.push(sellBarPredicate);
  if (onlyOpen) statusPreds.push(openAtClosePredicate);
  if (statusPreds.length > 0) {
    inner += ` AND ( ${statusPreds.join(' OR ')} )`;
  }

  return { inner, params, nextParamIndex: pi };
}
