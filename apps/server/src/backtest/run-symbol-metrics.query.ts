import { KLINE_INDICATOR_COLUMNS, KLINE_OP_MAP } from '../symbols/symbols.service';
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

  const onlyAction = dto.only_action_on_bar === true;
  const onlyOpen = dto.only_open_at_close === true;
  const needCandleJoin = onlyAction || onlyOpen;

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
        k.stop_loss_pct AS "stopLossPct"
      FROM (
        SELECT DISTINCT unnest($3::varchar[]) AS symbol
      ) p
      LEFT JOIN klines k
        ON k.symbol = p.symbol AND k.interval = $1 AND k.open_time = $2::timestamptz`;

  const params: unknown[] = [interval, tsDate, pool];
  let pi = 4;
  if (needCandleJoin) {
    inner += `
      LEFT JOIN backtest_candle_logs cl
        ON cl.run_id = $${pi} AND cl.ts = $2::timestamptz`;
    params.push(runId);
    pi += 1;
    if (onlyAction) {
      inner += `
      LEFT JOIN backtest_candle_logs prev
        ON prev.run_id = cl.run_id AND prev.bar_idx = cl.bar_idx - 1`;
    }
  }

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

  if (onlyAction) {
    // 与 entries/exits 一致；并兼容「收盘持仓集合相对上一根变化」但事件 JSON 未落库的边缘情况
    inner += ` AND (
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(cl.entries_json, '[]'::jsonb)) AS ej
          WHERE ej->>'symbol' = p.symbol
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(cl.exits_json, '[]'::jsonb)) AS xj
          WHERE xj->>'symbol' = p.symbol
        )
        OR (
          (COALESCE(cl.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol))
          IS DISTINCT FROM
          (COALESCE(prev.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol))
        )
      )`;
  }
  if (onlyOpen) {
    inner += ` AND COALESCE(cl.open_symbols_json, '[]'::jsonb) @> jsonb_build_array(p.symbol)`;
  }

  return { inner, params, nextParamIndex: pi };
}
