export type ASharesSyncMode = 'incremental' | 'overwrite';
export type ASharesDatasetKey = 'daily' | 'daily_basic' | 'adj_factor';

export type DatasetBaseline = 'self' | 'daily_quotes';

export interface DatasetCompletenessConfig {
  tableName: string;
  dateColumn: string;
  // 行级硬约束：这些列在数据集"完整"时必须每行非空。
  // PE/PB 等可合法 NULL 的列不放这里，避免亏损股触发误判。
  strictNonNullColumns: string[];
  // self：仅自身行数 > 0；
  // daily_quotes：当日 actual 行数必须 >= raw.daily_quote 当日行数，且 baseline > 0。
  baseline: DatasetBaseline;
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
