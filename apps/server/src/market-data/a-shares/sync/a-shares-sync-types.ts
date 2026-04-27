export type ASharesSyncMode = 'incremental' | 'overwrite';
export type ASharesDatasetKey = 'daily' | 'daily_basic' | 'adj_factor';

export interface DatasetCompletenessConfig {
  tableName: string;
  dateColumn: string;
  requiredColumns: string[];
}

export interface DailyQuotesSyncResult {
  count: number;
  tsCodes: string[];
}

export interface AdjFactorsSyncResult {
  count: number;
  tsCodes: string[];
  latestChangedTsCodes: string[];
}

export interface LatestAdjFactor {
  tradeDate: string;
  adjFactor: string | null;
}
