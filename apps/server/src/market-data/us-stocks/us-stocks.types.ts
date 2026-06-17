/**
 * 美股 Tab 查询/触发层 DTO 与行模型。
 *
 * 镜像 a-shares.types.ts，但**无**评分 / 买入信号（spec 05），
 * 列归一为裸 ticker（非 A 股 ts_code），主题筛选用 theme + stockType。
 */

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

/**
 * `POST /api/us-stocks/query` 请求体，镜像 AShareQueryBody。
 *
 * - priceMode 默认 'qfq'（前复权，技术分析口径）。
 * - theme / stockType 为主题与口径筛选（替代 A 股的 market / industry）。
 * - 无 watchlistIds / strategyHitIds / 评分排序（美股不接这些域）。
 */
export interface UsStockQueryBody {
  page?: number;
  pageSize?: number;
  q?: string;
  theme?: string | null;
  stockType?: string | null;
  priceMode?: 'qfq' | 'raw';
  sort?: { field?: string; order?: SortOrder; asc?: boolean };
  conditions?: QueryCondition[];
}

export interface UsStockRow {
  ticker: string;
  name: string | null;
  theme: string | null;
  stockType: string | null;
  close: string | null;
  pctChg: string | null;
  volume: string | null;
  tradeDate: string | null;
  // 指标字段（key 与前端共享 descriptor / us_daily_indicator 对齐）
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  bbi: number | null;
  kdjK: number | null;
  kdjD: number | null;
  kdjJ: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  atr14: number | null;
  low9: number | null;
  high9: number | null;
  stopLossPct: number | null;
  riskRewardRatio: number | null;
}

export interface UsStockQueryResult {
  rows: Array<Record<string, string | number | null>>;
  total: number;
  page: number;
  pageSize: number;
}

export interface UsStockKlineRow {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pctChg: number | null;
  volume: number;
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
  atr_14: number | null;
  low_9: number | null;
  high_9: number | null;
  stop_loss_pct: number | null;
  risk_reward_ratio: number | null;
}

export interface UsStockSummary {
  totalSymbols: string;
  trackedSymbols: string;
  latestTradeDate: string | null;
  upCount: string;
  downCount: string;
  quotedCount: string;
}

export interface UsStockFilterOptions {
  themes: Array<{ value: string }>;
  stockTypes: Array<{ value: string }>;
}

export interface UsStockSymbolItem {
  ticker: string;
  name: string | null;
  theme: string | null;
  stockType: string | null;
  tracked: boolean;
  listDate: string | null;
}

export interface UsStockTrackedUpdateItem {
  ticker: string;
  tracked: boolean;
}

export interface UsStockTrackedUpdateBody {
  items: UsStockTrackedUpdateItem[];
}

/** `POST /api/us-stocks/sync` 请求体（写 ml.jobs run_type='us_sync'）。 */
export interface UsStockSyncBody {
  /** [startDate, endDate]，YYYYMMDD；缺省时由 Python 侧用默认区间 */
  dateRange?: [string, string];
  /** 限定同步的 ticker 列表；缺省时同步全部 tracked */
  tickers?: string[];
}

/**
 * `POST /api/us-stocks/one-click-sync` 请求体（写 ml.jobs run_type='us_one_click_sync'）。
 *
 * dateRange **必填**（区别于 sync()，一键同步无「缺省全量」语义，必须带窗口）。
 * 不传 tickers/symbols：编排器内部固定 tracked 全集 + `.NDX`。
 */
export interface UsOneClickSyncBody {
  /** [startDate, endDate]，YYYYMMDD；必填 */
  dateRange: [string, string];
}
