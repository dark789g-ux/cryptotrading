export type ASharesSyncMode = 'incremental' | 'overwrite';
export type ASharesDatasetKey = 'daily' | 'daily_basic' | 'adj_factor';

export interface SyncSymbolsResult {
  count: number;
  tsCodes: string[];
}

export interface DailyQuotesSyncResult {
  count: number;
  tsCodes: string[];
  partial?: boolean;
  backfilled?: number;
}

export interface DailyMetricsSyncResult {
  count: number;
  tsCodes: string[];
  partial?: boolean;
  backfilled?: number;
}

export interface AdjFactorsSyncResult {
  count: number;
  tsCodes: string[];
  latestChangedTsCodes: string[];
  partial?: boolean;
  backfilled?: number;
}

export interface LatestAdjFactor {
  tradeDate: string;
  adjFactor: string | null;
}
