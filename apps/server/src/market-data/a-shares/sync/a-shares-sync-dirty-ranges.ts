import type { Repository } from 'typeorm';
import type { DailyQuoteEntity } from '../../../entities/raw/daily-quote.entity';
import type { AShareSyncStateEntity } from '../../../entities/a-share/a-share-sync-state.entity';

export interface ASharesSyncDirtyRangeDeps {
  quoteRepo: Repository<DailyQuoteEntity>;
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
  const tsCodes = [...changedRanges.keys()];

  // 除权对账：批量查出所有涉及股票的 adj_factor 最后变化日期
  const exDateRows = tsCodes.length > 0
    ? await deps.quoteRepo.query<Array<{ tsCode: string; lastExDate: string }>>(`
        WITH changes AS (
          SELECT ts_code, trade_date, adj_factor,
                 LAG(adj_factor) OVER (PARTITION BY ts_code ORDER BY trade_date) AS prev_f
          FROM raw.adj_factor
          WHERE ts_code = ANY($1)
        )
        SELECT ts_code AS "tsCode", MAX(trade_date) AS "lastExDate"
        FROM changes
        WHERE adj_factor IS DISTINCT FROM prev_f
        GROUP BY ts_code
      `, [tsCodes])
    : [];

  const lastExDateMap = new Map<string, string>();
  for (const row of exDateRows) {
    lastExDateMap.set(row.tsCode, row.lastExDate);
  }

  // 批量查出每只股票 daily_indicator 最早一行的 updated_at（YYYYMMDD）
  // 全量重算会刷新所有行的 updated_at（含最早行）；若最早行 updated_at 早于最近除权日，
  // 说明除权后该股票 indicator 未被全量重算覆盖，需要从 IPO 日重算
  const indicatorEarliestUpdatedRows = tsCodes.length > 0
    ? await deps.quoteRepo.query<Array<{ tsCode: string; earliestUpdated: string }>>(`
        SELECT ts_code AS "tsCode", TO_CHAR(MIN(updated_at), 'YYYYMMDD') AS "earliestUpdated"
        FROM raw.daily_indicator
        WHERE ts_code = ANY($1)
        GROUP BY ts_code
      `, [tsCodes])
    : [];

  const indicatorEarliestUpdatedMap = new Map<string, string>();
  for (const row of indicatorEarliestUpdatedRows) {
    indicatorEarliestUpdatedMap.set(row.tsCode, row.earliestUpdated);
  }

  // 批量查出所有涉及股票的最早行情日（替代循环内逐只 resolveEarliestQuoteDate）
  const earliestQuoteDateRows = tsCodes.length > 0
    ? await deps.quoteRepo.query<Array<{ tsCode: string; earliestDate: string }>>(`
        SELECT ts_code AS "tsCode", MIN(trade_date) AS "earliestDate"
        FROM raw.daily_quote
        WHERE ts_code = ANY($1)
        GROUP BY ts_code
      `, [tsCodes])
    : [];

  const earliestDateMap = new Map<string, string>();
  for (const row of earliestQuoteDateRows) {
    earliestDateMap.set(row.tsCode, row.earliestDate);
  }

  // 内存计算每只股票的 dirtyFrom（不再触发 DB 查询）
  const dirtyFromByTsCode = new Map<string, string>();
  for (const [tsCode, tradeDate] of changedRanges) {
    let dirtyFrom = latestAdjFactorChanged.has(tsCode)
      ? (earliestDateMap.get(tsCode) ?? tradeDate)
      : tradeDate;

    // 除权对账兜底：若最近除权日严格晚于 indicator 表最早行的 updated_at，
    // 说明除权事件后该股票的 indicator 历史行从未被全量刷新过，强制从 IPO 日重算
    const lastExDate = lastExDateMap.get(tsCode);
    const earliestUpdated = indicatorEarliestUpdatedMap.get(tsCode);
    if (lastExDate && earliestUpdated && lastExDate > earliestUpdated) {
      dirtyFrom = earliestDateMap.get(tsCode) ?? dirtyFrom;
    }
    dirtyFromByTsCode.set(tsCode, dirtyFrom);
  }

  // 批量 UPSERT（一条 SQL 完成所有股票的 dirty 标记，替代循环内逐条 UPSERT）
  if (dirtyFromByTsCode.size > 0) {
    const tsCodeArr = [...dirtyFromByTsCode.keys()];
    const dirtyFromArr = tsCodeArr.map((code) => dirtyFromByTsCode.get(code)!);
    await deps.syncStateRepo.query(`
      INSERT INTO a_share_sync_states (
        ts_code,
        qfq_dirty_from_date,
        indicator_dirty_from_date,
        amv_dirty_from_date,
        updated_at
      )
      SELECT
        unnest($1::text[]) AS ts_code,
        unnest($2::text[]) AS qfq_dirty_from_date,
        unnest($2::text[]) AS indicator_dirty_from_date,
        unnest($2::text[]) AS amv_dirty_from_date,
        now()
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
        amv_dirty_from_date = CASE
          WHEN a_share_sync_states.amv_dirty_from_date IS NULL THEN EXCLUDED.amv_dirty_from_date
          WHEN EXCLUDED.amv_dirty_from_date < a_share_sync_states.amv_dirty_from_date THEN EXCLUDED.amv_dirty_from_date
          ELSE a_share_sync_states.amv_dirty_from_date
        END,
        updated_at = now()
    `, [tsCodeArr, dirtyFromArr]);
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
      FROM raw.daily_quote q
      LEFT JOIN raw.adj_factor f ON f.ts_code = q.ts_code AND f.trade_date = q.trade_date
      LEFT JOIN LATERAL (
        SELECT lf.adj_factor
        FROM raw.adj_factor lf
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
        FROM raw.daily_quote pq
        WHERE pq.ts_code = $1
          AND pq.trade_date < $2
          AND pq.qfq_close IS NOT NULL
        ORDER BY pq.trade_date DESC
        LIMIT 1
      ) prev ON true
    )
    UPDATE raw.daily_quote AS target
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
      signal_rolling_dirty_from_date,
      amv_dirty_from_date,
      updated_at
    )
    VALUES ($1, NULL, $2, $2, $2, now())
    ON CONFLICT (ts_code) DO UPDATE SET
      qfq_dirty_from_date = NULL,
      indicator_dirty_from_date = CASE
        WHEN a_share_sync_states.indicator_dirty_from_date IS NULL THEN EXCLUDED.indicator_dirty_from_date
        WHEN EXCLUDED.indicator_dirty_from_date < a_share_sync_states.indicator_dirty_from_date THEN EXCLUDED.indicator_dirty_from_date
        ELSE a_share_sync_states.indicator_dirty_from_date
      END,
      signal_rolling_dirty_from_date = CASE
        WHEN a_share_sync_states.signal_rolling_dirty_from_date IS NULL THEN EXCLUDED.signal_rolling_dirty_from_date
        WHEN EXCLUDED.signal_rolling_dirty_from_date < a_share_sync_states.signal_rolling_dirty_from_date THEN EXCLUDED.signal_rolling_dirty_from_date
        ELSE a_share_sync_states.signal_rolling_dirty_from_date
      END,
      amv_dirty_from_date = CASE
        WHEN a_share_sync_states.amv_dirty_from_date IS NULL THEN EXCLUDED.amv_dirty_from_date
        WHEN EXCLUDED.amv_dirty_from_date < a_share_sync_states.amv_dirty_from_date THEN EXCLUDED.amv_dirty_from_date
        ELSE a_share_sync_states.amv_dirty_from_date
      END,
      updated_at = now()
  `, [tsCode, dirtyFrom]);
}

