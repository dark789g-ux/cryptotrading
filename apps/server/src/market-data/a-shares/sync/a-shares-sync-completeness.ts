import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AShareDailyQuoteEntity } from '../../../entities/a-share/a-share-daily-quote.entity';
import type { ASharesDatasetKey, ASharesSyncMode, DatasetCompletenessConfig } from './a-shares-sync-types';

const logger = new Logger('ASharesSyncCompleteness');

const DAILY_QUOTES_TABLE = 'a_share_daily_quotes';

const DATASET_COMPLETENESS: Record<ASharesDatasetKey, DatasetCompletenessConfig> = {
  daily: {
    tableName: DAILY_QUOTES_TABLE,
    dateColumn: 'trade_date',
    strictNonNullColumns: ['open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'],
    baseline: 'self',
  },
  daily_basic: {
    tableName: 'a_share_daily_metrics',
    dateColumn: 'trade_date',
    // turnover_rate / total_mv / circ_mv 在实测数据中 100% 非空；
    // pe / pe_ttm / pb / volume_ratio 对亏损股或停牌股合法为 NULL，不能作硬约束。
    strictNonNullColumns: ['turnover_rate', 'total_mv', 'circ_mv'],
    baseline: 'daily_quotes',
  },
  adj_factor: {
    tableName: 'a_share_adj_factors',
    dateColumn: 'trade_date',
    strictNonNullColumns: ['adj_factor'],
    baseline: 'daily_quotes',
  },
};

export async function shouldSyncDataset(
  quoteRepo: Repository<AShareDailyQuoteEntity>,
  syncMode: ASharesSyncMode,
  dataset: ASharesDatasetKey,
  tradeDate: string,
): Promise<boolean> {
  if (syncMode === 'overwrite') return true;
  return !(await isDatasetComplete(quoteRepo, dataset, tradeDate));
}

async function isDatasetComplete(
  quoteRepo: Repository<AShareDailyQuoteEntity>,
  dataset: ASharesDatasetKey,
  tradeDate: string,
): Promise<boolean> {
  const config = DATASET_COMPLETENESS[dataset];
  const nullChecks = config.strictNonNullColumns
    .map((col) => `COUNT(*) FILTER (WHERE ${col} IS NULL) AS "${col}__nulls"`)
    .join(', ');
  const baselineSubquery =
    config.baseline === 'daily_quotes'
      ? `, (SELECT COUNT(*) FROM ${DAILY_QUOTES_TABLE} WHERE trade_date = $1) AS "__baseline"`
      : '';
  const sql = `
    SELECT
      COUNT(*) AS "__total"
      ${nullChecks ? `, ${nullChecks}` : ''}
      ${baselineSubquery}
    FROM ${config.tableName}
    WHERE ${config.dateColumn} = $1
  `;
  const rows = await quoteRepo.query<Array<Record<string, string | null>>>(sql, [tradeDate]);
  const row = rows[0];
  if (!row) return false;

  const total = Number(row.__total ?? 0);
  if (total <= 0) return false;

  for (const col of config.strictNonNullColumns) {
    const nulls = Number(row[`${col}__nulls`] ?? 0);
    if (nulls > 0) {
      logger.warn(
        `${dataset} ${tradeDate} 列 ${col} 存在 ${nulls} 行 NULL（共 ${total} 行），判定不完整以触发补齐`,
      );
      return false;
    }
  }

  if (config.baseline === 'daily_quotes') {
    const baseline = Number(row.__baseline ?? 0);
    if (baseline <= 0) {
      // daily_quotes 当日尚未落库，子数据集无从对齐——视为不完整，等本轮 daily 同步后再判
      return false;
    }
    if (total < baseline) {
      logger.warn(
        `${dataset} ${tradeDate} 行数 ${total} < a_share_daily_quotes 行数 ${baseline}，判定不完整以触发补齐`,
      );
      return false;
    }
  }

  return true;
}
