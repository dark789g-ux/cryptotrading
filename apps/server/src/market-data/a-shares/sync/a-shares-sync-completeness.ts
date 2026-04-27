import type { Repository } from 'typeorm';
import type { AShareDailyQuoteEntity } from '../../../entities/a-share/a-share-daily-quote.entity';
import type { ASharesDatasetKey, ASharesSyncMode, DatasetCompletenessConfig } from './a-shares-sync-types';

const DATASET_COMPLETENESS: Record<ASharesDatasetKey, DatasetCompletenessConfig> = {
  daily: {
    tableName: 'a_share_daily_quotes',
    dateColumn: 'trade_date',
    requiredColumns: ['open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'],
  },
  daily_basic: {
    tableName: 'a_share_daily_metrics',
    dateColumn: 'trade_date',
    requiredColumns: ['turnover_rate', 'volume_ratio', 'pe', 'pe_ttm', 'pb', 'total_mv', 'circ_mv'],
  },
  adj_factor: {
    tableName: 'a_share_adj_factors',
    dateColumn: 'trade_date',
    requiredColumns: ['adj_factor'],
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
  const checks = config.requiredColumns
    .map((column) => `COUNT(*) FILTER (WHERE ${column} IS NOT NULL) AS "${column}"`)
    .join(',\n');
  const rows = await quoteRepo.query<Array<Record<string, string>>>(`
    SELECT
      COUNT(*) AS "__total",
      ${checks}
    FROM ${config.tableName}
    WHERE ${config.dateColumn} = $1
  `, [tradeDate]);
  const row = rows[0];
  if (!row || Number(row.__total ?? 0) <= 0) return false;
  return config.requiredColumns.every((column) => Number(row[column] ?? 0) > 0);
}
