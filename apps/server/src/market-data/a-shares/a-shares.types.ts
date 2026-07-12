import type { BrickChartPoint } from '../../indicators/brick-chart';

export type SortOrder = 'ascend' | 'descend' | null;

export type QueryConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

export interface QueryNumberCondition {
  field: string;
  op: QueryConditionOp;
  valueType?: 'number';
  value: number;
}

export interface QueryFieldCondition {
  field: string;
  op: QueryConditionOp;
  valueType: 'field';
  compareField: string;
}

export type QueryCondition = QueryNumberCondition | QueryFieldCondition;

export interface SearchASharesQueryDto {
  q: string;
  limit?: number;
}

export interface AShareSearchResult {
  tsCode: string;
  symbol: string;
  name: string;
}

export interface QueryASharesDto {
  page?: number;
  pageSize?: number;
  q?: string;
  market?: string | null;
  swIndustryL1Code?: string | null;
  swIndustryL2Code?: string | null;
  swIndustryL3Code?: string | null;
  priceMode?: 'qfq' | 'raw';
  sort?: { field?: string; order?: SortOrder; asc?: boolean };
  conditions?: QueryCondition[];
  watchlistIds?: string[];
  strategyHitIds?: string[];
  indexTsCode?: string;
  /** 显式 ts_code 列表（如自定义指数成分跳转）；与 indexTsCode 互斥 */
  tsCodes?: string[];
  /** 为 true 时跳过 COUNT，响应 total=-1（排序/翻页复用前端已有 total） */
  skipCount?: boolean;
}

export interface ASharesFilterPresetFilters {
  searchQuery: string;
  selectedMarket: string | null;
  selectedSwIndustryL1Code: string | null;
  selectedSwIndustryL2Code: string | null;
  selectedSwIndustryL3Code: string | null;
  priceMode: 'qfq' | 'raw';
  pctChangeMin: number | null;
  turnoverRateMin: number | null;
  advancedConditions: QueryCondition[];
}

export interface ASharesFilterPresetDto {
  id: string;
  name: string;
  filters: ASharesFilterPresetFilters;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncASharesDto {
  tradeDate?: string;
  startDate?: string;
  endDate?: string;
  syncMode?: 'incremental' | 'overwrite';
  /** 取消信号（一键同步编排器注入，循环顶部检查 signal.aborted） */
  signal?: AbortSignal;
}

export type ASharesSyncStatus = 'done' | 'partial' | 'error';

export interface ASharesSyncFailedItem {
  tradeDate?: string;
  apiName: string;
  message: string;
}

export interface ASharesSyncResult {
  ok: boolean;
  status: ASharesSyncStatus;
  symbols: number;
  quotes: number;
  metrics: number;
  adjFactors: number;
  indicators: number;
  failedCount: number;
  failedItems: ASharesSyncFailedItem[];
  startDate: string;
  endDate: string;
  skippedDates?: number;
  skippedDatasets?: number;
}

export interface ASharesSyncEvent extends Partial<ASharesSyncResult> {
  type: 'start' | 'progress' | 'done' | 'error';
  phase?: string;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface AShareQuoteForIndicator {
  tsCode: string;
  tradeDate: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  qfqOpen: string | null;
  qfqHigh: string | null;
  qfqLow: string | null;
  qfqClose: string | null;
  vol: string | null;
  amount: string | null;
}

export type AShareSuspendStatus = 'none' | 'suspended';

export interface AShareSuspendInfo {
  status: AShareSuspendStatus;
  sinceDate: string | null;
  timing: string | null;
  lastQuoteTradeDate: string | null;
  asOfTradeDate?: string | null;
}

export interface AShareQueryRowSuspendFields {
  suspendStatus: AShareSuspendStatus;
  suspendSinceDate: string | null;
  suspendTiming: string | null;
  lastQuoteTradeDate: string | null;
  quoteIsStale: boolean;
}

export interface AShareKlinesResponse {
  bars: AShareKlineRow[];
  suspend: AShareSuspendInfo;
}

export interface AShareKlineRow {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pctChg: number | null;
  volume: number;
  quote_volume: number;
  DIF: number | null;
  DEA: number | null;
  MACD: number | null;
  'KDJ.K': number | null;
  'KDJ.D': number | null;
  'KDJ.J': number | null;
  BBI: number | null;
  MA5: number | null;
  MA30: number | null;
  MA60: number | null;
  MA120: number | null;
  MA240: number | null;
  VWAP5: number | null;
  VWAP10: number | null;
  VWAP20: number | null;
  '10_quote_volume': number | null;
  atr_14: number | null;
  loss_atr_14: number | null;
  low_9: number | null;
  high_9: number | null;
  stop_loss_pct: number | null;
  risk_reward_ratio: number | null;
  turnoverRate: number | null;
  volumeRatio: number | null;
  pe: number | null;
  peTtm: number | null;
  pb: number | null;
  totalMv: number | null;
  circMv: number | null;
  brickChart?: BrickChartPoint;
}

export interface ASharesSyncRange {
  startDate: string;
  endDate: string;
}
