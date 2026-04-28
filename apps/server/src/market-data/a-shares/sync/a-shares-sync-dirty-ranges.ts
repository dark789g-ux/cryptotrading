import type { Repository } from 'typeorm';
import type { AShareDailyQuoteEntity } from '../../../entities/a-share/a-share-daily-quote.entity';
import type { AShareSyncStateEntity } from '../../../entities/a-share/a-share-sync-state.entity';

export interface ASharesSyncDirtyRangeDeps {
  quoteRepo: Repository<AShareDailyQuoteEntity>;
  syncStateRepo: Repository<AShareSyncStateEntity>;
}

export type ASharesSymbolProgressCallback = (current: number, total: number, tsCode: string) => void;

export function mergeChangedDates(target: Map<string, string>, tsCodes: string[], tradeDate: string): void {
  for (const tsCode of tsCodes) {
    const existing = target.get(tsCode);
    if (!existing || tradeDate < existing) target.set(tsCode, tradeDate);
  }
}

export async function markDirtyRanges(
  deps: ASharesSyncDirtyRangeDeps,
  changedRanges: Map<string, string>,
  latestAdjFactorChanged: Set<string>,
): Promise<void> {
  for (const [tsCode, tradeDate] of changedRanges) {
    const dirtyFrom = latestAdjFactorChanged.has(tsCode)
      ? await resolveEarliestQuoteDate(deps.quoteRepo, tsCode, tradeDate)
      : tradeDate;
    await deps.syncStateRepo.query(`
      INSERT INTO a_share_sync_states (
        ts_code,
        qfq_dirty_from_date,
        indicator_dirty_from_date,
        updated_at
      )
      VALUES ($1, $2, $2, now())
      ON CONFLICT (ts_code) DO UPDATE SET
        qfq_dirty_from_date = CASE
          WHEN a_share_sync_states.qfq_dirty_from_date IS NULL THEN EXCLUDED.qfq_dirty_from_date
          WHEN EXCLUDED.qfq_dirty_from_date < a_share_sync_states.qfq_dirty_from_date THEN EXCLUDED.qfq_dirty_from_date
          ELSE a_share_sync_states.qfq_dirty_from_date
        END,
        indicator_dirty_from_date = CASE
          WHEN a_share_sync_states.indicator_dirty_from_date IS NULL THEN EXCLUDED.indicator_dirty_from_date
          WHEN EXCLUDED.indicator_dirty_from_date < a_share_sync_states.indicator_dirty_from_date THEN EXCLUDED.indicator_dirty_from_date
          ELSE a_share_sync_states.indicator_dirty_from_date
        END,
        updated_at = now()
    `, [tsCode, dirtyFrom]);
  }
}

export async function recalculateDirtyQfqQuotes(
  deps: ASharesSyncDirtyRangeDeps,
  tsCodes: string[],
  onProgress?: ASharesSymbolProgressCallback,
): Promise<void> {
  const targetTsCodes = [...new Set(tsCodes)].filter((value) => value.length > 0).sort();
  for (let index = 0; index < targetTsCodes.length; index++) {
    const tsCode = targetTsCodes[index];
    await recalculateDirtyQfqQuotesForSymbol(deps, tsCode);
    onProgress?.(index + 1, targetTsCodes.length, tsCode);
  }
}

async function recalculateDirtyQfqQuotesForSymbol(
  deps: ASharesSyncDirtyRangeDeps,
  tsCode: string,
): Promise<void> {
  const state = await deps.syncStateRepo.findOne({ where: { tsCode } });
  const dirtyFrom = state?.qfqDirtyFromDate;
  if (!dirtyFrom) return;
  await deps.quoteRepo.query(`
    WITH adjusted AS (
      SELECT
        q.id,
        q.trade_date,
        CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.open * f.adj_factor / latest.adj_factor END AS qfq_open,
        CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.high * f.adj_factor / latest.adj_factor END AS qfq_high,
        CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.low * f.adj_factor / latest.adj_factor END AS qfq_low,
        CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.close * f.adj_factor / latest.adj_factor END AS qfq_close
      FROM a_share_daily_quotes q
      LEFT JOIN a_share_adj_factors f ON f.ts_code = q.ts_code AND f.trade_date = q.trade_date
      LEFT JOIN LATERAL (
        SELECT lf.adj_factor
        FROM a_share_adj_factors lf
        WHERE lf.ts_code = q.ts_code
          AND lf.adj_factor IS NOT NULL
        ORDER BY lf.trade_date DESC
        LIMIT 1
      ) latest ON true
      WHERE q.ts_code = $1
        AND q.trade_date >= $2
    ),
    with_prev AS (
      SELECT
        adjusted.id,
        qfq_open,
        qfq_high,
        qfq_low,
        qfq_close,
        COALESCE(
          LAG(qfq_close) OVER (ORDER BY adjusted.trade_date ASC),
          prev.prev_qfq_close
        ) AS qfq_pre_close
      FROM adjusted
      LEFT JOIN LATERAL (
        SELECT pq.qfq_close AS prev_qfq_close
        FROM a_share_daily_quotes pq
        WHERE pq.ts_code = $1
          AND pq.trade_date < $2
          AND pq.qfq_close IS NOT NULL
        ORDER BY pq.trade_date DESC
        LIMIT 1
      ) prev ON true
    )
    UPDATE a_share_daily_quotes AS target
    SET
      qfq_open = with_prev.qfq_open,
      qfq_high = with_prev.qfq_high,
      qfq_low = with_prev.qfq_low,
      qfq_close = with_prev.qfq_close,
      qfq_pre_close = with_prev.qfq_pre_close,
      qfq_change = CASE
        WHEN with_prev.qfq_close IS NULL OR with_prev.qfq_pre_close IS NULL THEN NULL
        ELSE with_prev.qfq_close - with_prev.qfq_pre_close
      END,
      qfq_pct_chg = CASE
        WHEN with_prev.qfq_close IS NULL OR with_prev.qfq_pre_close IS NULL OR with_prev.qfq_pre_close = 0 THEN NULL
        ELSE (with_prev.qfq_close - with_prev.qfq_pre_close) / with_prev.qfq_pre_close * 100
      END
    FROM with_prev
    WHERE target.id = with_prev.id
  `, [tsCode, dirtyFrom]);
  await deps.syncStateRepo.query(`
    INSERT INTO a_share_sync_states (
      ts_code,
      qfq_dirty_from_date,
      indicator_dirty_from_date,
      updated_at
    )
    VALUES ($1, NULL, $2, now())
    ON CONFLICT (ts_code) DO UPDATE SET
      qfq_dirty_from_date = NULL,
      indicator_dirty_from_date = CASE
        WHEN a_share_sync_states.indicator_dirty_from_date IS NULL THEN EXCLUDED.indicator_dirty_from_date
        WHEN EXCLUDED.indicator_dirty_from_date < a_share_sync_states.indicator_dirty_from_date THEN EXCLUDED.indicator_dirty_from_date
        ELSE a_share_sync_states.indicator_dirty_from_date
      END,
      updated_at = now()
  `, [tsCode, dirtyFrom]);
}

async function resolveEarliestQuoteDate(
  quoteRepo: Repository<AShareDailyQuoteEntity>,
  tsCode: string,
  fallback: string,
): Promise<string> {
  const rows = await quoteRepo.query<Array<{ tradeDate: string }>>(`
    SELECT MIN(trade_date) AS "tradeDate"
    FROM a_share_daily_quotes
    WHERE ts_code = $1
  `, [tsCode]);
  return rows[0]?.tradeDate ?? fallback;
}
