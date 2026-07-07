import type { Repository } from 'typeorm';
import type { DailyQuoteEntity } from '../../../entities/raw/daily-quote.entity';
import type { ASharesDatasetKey, ASharesSyncMode } from './a-shares-sync-types';
import {
  DatasetCompletenessConfig,
  isDatasetComplete,
} from '../../_shared/dataset-completeness';

const DAILY_QUOTES_TABLE = 'raw.daily_quote';

const DATASET_COMPLETENESS: Record<ASharesDatasetKey, DatasetCompletenessConfig> = {
  daily: {
    tableName: DAILY_QUOTES_TABLE,
    dateColumn: 'trade_date',
    strictNonNullColumns: ['open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'],
    baseline: { table: 'a_share_symbols', filter: "list_status = 'L'" },
    toleranceRatio: 0.05,
  },
  daily_basic: {
    tableName: 'raw.daily_basic',
    dateColumn: 'trade_date',
    strictNonNullColumns: ['turnover_rate', 'total_mv', 'circ_mv'],
    baseline: { table: DAILY_QUOTES_TABLE, dateColumn: 'trade_date' },
    toleranceRatio: 0.02,
  },
  adj_factor: {
    tableName: 'raw.adj_factor',
    dateColumn: 'trade_date',
    strictNonNullColumns: ['adj_factor'],
    baseline: { table: DAILY_QUOTES_TABLE, dateColumn: 'trade_date' },
    toleranceRatio: 0.02,
  },
};

export async function shouldSyncDataset(
  quoteRepo: Repository<DailyQuoteEntity>,
  syncMode: ASharesSyncMode,
  dataset: ASharesDatasetKey,
  tradeDate: string,
): Promise<boolean> {
  if (syncMode === 'overwrite') return true;
  return !(await isDatasetComplete(quoteRepo, DATASET_COMPLETENESS[dataset], tradeDate));
}
