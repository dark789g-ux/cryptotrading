export type ASharesSyncMode = 'incremental' | 'overwrite';
export type ASharesDatasetKey = 'daily' | 'daily_basic' | 'adj_factor';

// DatasetCompletenessConfig 已上移为通用版：
//   import { DatasetCompletenessConfig } from '../../_shared/dataset-completeness'
// baseline 字段从二元枚举 'self' | 'daily_quotes' 扩展为：
//   'self' | { table: string; dateColumn?: string; filter?: string }
// 见 _shared/dataset-completeness.ts 头注释。

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
