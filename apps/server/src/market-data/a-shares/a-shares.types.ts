import type { BrickChartPoint } from '../../indicators/brick-chart';

export type SortOrder = 'ascend' | 'descend' | null;

export interface QueryCondition {
  field: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value: number;
}

export interface QueryASharesDto {
  page?: number;
  pageSize?: number;
  q?: string;
  market?: string | null;
  industry?: string | null;
  priceMode?: 'qfq' | 'raw';
  sort?: { field?: string; order?: SortOrder; asc?: boolean };
  conditions?: QueryCondition[];
}

export interface SyncASharesDto {
  tradeDate?: string;
  startDate?: string;
  endDate?: string;
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
  pb: number | null;
  totalMv: number | null;
  circMv: number | null;
  brickChart?: BrickChartPoint;
}

export interface ASharesSyncRange {
  startDate: string;
  endDate: string;
}
