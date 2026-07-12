/**
 * Reusable SQL fragments for A-share suspension status (raw.suspend_d).
 *
 * State machine (single source of truth):
 *   asOf = MAX(trade_date) FROM raw.daily_quote
 *   latest event = most recent row in suspend_d with trade_date <= asOf
 *                  (same-day S+R → R wins via ORDER BY suspend_type)
 *   suspend_type = 'S' → suspended; otherwise none
 *
 * Missing tradeDate on daily_quote is NOT treated as suspended.
 */

/** Same-day tie-break: R before S (lower sort key wins). */
export const SUSPEND_TYPE_ORDER = "CASE sd.suspend_type WHEN 'R' THEN 0 ELSE 1 END";

/**
 * LATERAL join: latest effective suspend event per symbol at asOf (l.trade_date).
 * Exposes: suspend_status ('none'|'suspended'), suspend_since_date, suspend_timing.
 */
export const A_SHARES_SUSPEND_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN le.suspend_type = 'S' THEN 'suspended' ELSE 'none' END AS suspend_status,
          CASE WHEN le.suspend_type = 'S' THEN ss.since_date ELSE NULL END AS suspend_since_date,
          CASE WHEN le.suspend_type = 'S' THEN le.suspend_timing ELSE NULL END AS suspend_timing
        FROM (
          SELECT sd.suspend_type, sd.trade_date, sd.suspend_timing
          FROM raw.suspend_d sd
          WHERE sd.ts_code = s.ts_code AND sd.trade_date <= l.trade_date
          ORDER BY sd.trade_date DESC, ${SUSPEND_TYPE_ORDER}
          LIMIT 1
        ) le
        LEFT JOIN LATERAL (
          SELECT MIN(sd2.trade_date) AS since_date
          FROM raw.suspend_d sd2
          WHERE sd2.ts_code = s.ts_code
            AND sd2.suspend_type = 'S'
            AND sd2.trade_date <= l.trade_date
            AND sd2.trade_date > COALESCE((
              SELECT MAX(sd3.trade_date)
              FROM raw.suspend_d sd3
              WHERE sd3.ts_code = s.ts_code
                AND sd3.suspend_type = 'R'
                AND sd3.trade_date < le.trade_date
            ), '00000000')
        ) ss ON le.suspend_type = 'S'
      ) sus ON true`;

/** LATERAL join: most recent daily_quote row (stale-price fallback when suspended). */
export const A_SHARES_LAST_QUOTE_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT trade_date, close, change, pct_chg, qfq_close, qfq_change, qfq_pct_chg
        FROM raw.daily_quote
        WHERE ts_code = s.ts_code
        ORDER BY trade_date DESC
        LIMIT 1
      ) lq ON true`;

/** SELECT aliases for list/hydrate queries (requires sus + lq laterals). */
export function buildSuspendSelectAliases(): string {
  return `
        COALESCE(sus.suspend_status, 'none') AS "suspendStatus",
        sus.suspend_since_date AS "suspendSinceDate",
        sus.suspend_timing AS "suspendTiming",
        lq.trade_date AS "lastQuoteTradeDate",
        COALESCE(sus.suspend_status = 'suspended' AND q.trade_date IS NULL AND lq.trade_date IS NOT NULL, false) AS "quoteIsStale"`;
}

interface StalePriceCols {
  close: string;
  change: string;
  pctChg: string;
}

/** Stale-aware price column: fallback to lq when suspended and asOf quote missing. */
export function buildStaleAwarePriceExpr(currentCol: string, fallbackCol: string): string {
  return `CASE WHEN sus.suspend_status = 'suspended' AND q.trade_date IS NULL THEN ${fallbackCol} ELSE ${currentCol} END`;
}

/** Stale-aware tradeDate for list rows. */
export function buildStaleAwareTradeDateExpr(): string {
  return `CASE WHEN sus.suspend_status = 'suspended' AND q.trade_date IS NULL THEN lq.trade_date ELSE q.trade_date END`;
}

/** Build stale-aware close/change/pctChg SELECT lines for hydrate query. */
export function buildStaleAwarePriceSelect(priceMode: 'raw' | 'qfq'): {
  close: string;
  change: string;
  pctChg: string;
  tradeDate: string;
} {
  const current: StalePriceCols = priceMode === 'raw'
    ? { close: 'q.close', change: 'q.change', pctChg: 'q.pct_chg' }
    : { close: 'q.qfq_close', change: 'q.qfq_change', pctChg: 'q.qfq_pct_chg' };
  const fallback: StalePriceCols = priceMode === 'raw'
    ? { close: 'lq.close', change: 'lq.change', pctChg: 'lq.pct_chg' }
    : { close: 'lq.qfq_close', change: 'lq.qfq_change', pctChg: 'lq.qfq_pct_chg' };

  return {
    close: buildStaleAwarePriceExpr(current.close, fallback.close),
    change: buildStaleAwarePriceExpr(current.change, fallback.change),
    pctChg: buildStaleAwarePriceExpr(current.pctChg, fallback.pctChg),
    tradeDate: buildStaleAwareTradeDateExpr(),
  };
}

/**
 * Single-stock suspend snapshot (klines companion query).
 * Param $1 = ts_code. Returns status, sinceDate, timing, lastQuoteTradeDate, asOfTradeDate.
 */
export function buildSingleStockSuspendSql(): string {
  return `
      WITH latest AS (
        SELECT MAX(trade_date) AS trade_date FROM raw.daily_quote
      ),
      last_event AS (
        SELECT sd.suspend_type, sd.trade_date, sd.suspend_timing
        FROM raw.suspend_d sd
        CROSS JOIN latest l
        WHERE sd.ts_code = $1 AND sd.trade_date <= l.trade_date
        ORDER BY sd.trade_date DESC, ${SUSPEND_TYPE_ORDER}
        LIMIT 1
      ),
      since_date AS (
        SELECT MIN(sd2.trade_date) AS since_date
        FROM raw.suspend_d sd2
        CROSS JOIN last_event le
        CROSS JOIN latest l
        WHERE sd2.ts_code = $1
          AND sd2.suspend_type = 'S'
          AND sd2.trade_date <= l.trade_date
          AND le.suspend_type = 'S'
          AND sd2.trade_date > COALESCE((
            SELECT MAX(sd3.trade_date)
            FROM raw.suspend_d sd3
            WHERE sd3.ts_code = $1
              AND sd3.suspend_type = 'R'
              AND sd3.trade_date < le.trade_date
          ), '00000000')
      ),
      last_quote AS (
        SELECT MAX(trade_date) AS trade_date
        FROM raw.daily_quote
        WHERE ts_code = $1
      )
      SELECT
        l.trade_date AS "asOfTradeDate",
        CASE WHEN le.suspend_type = 'S' THEN 'suspended' ELSE 'none' END AS status,
        CASE WHEN le.suspend_type = 'S' THEN sd.since_date ELSE NULL END AS "sinceDate",
        CASE WHEN le.suspend_type = 'S' THEN le.suspend_timing ELSE NULL END AS timing,
        lq.trade_date AS "lastQuoteTradeDate"
      FROM latest l
      LEFT JOIN last_event le ON true
      LEFT JOIN since_date sd ON true
      LEFT JOIN last_quote lq ON true`;
}
