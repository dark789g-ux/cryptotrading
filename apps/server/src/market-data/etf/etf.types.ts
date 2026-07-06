/** ETF 同步结果类型 */

export interface EtfSyncErrorItem {
  apiName: string;
  message: string;
}

/** ETF 同步进度事件（逐项循环埋点用） */
export interface EtfSyncProgress {
  phase: string;
  percent: number;
  message?: string;
}

export type EtfSyncOnProgress = (p: EtfSyncProgress) => void;

export interface EtfSyncResult {
  success: number;
  errors: EtfSyncErrorItem[];
}

/** Tushare fund_daily 行（OHLCV + 复权） */
export interface FundDailyRow {
  ts_code: string;
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  pre_close: number | null;
  change: number | null;
  pct_chg: number | null;
  vol: number | null;
  amount: number | null;
}

/** Tushare fund_adj 行（复权因子） */
export interface FundAdjRow {
  ts_code: string;
  trade_date: string;
  adj_factor: number;
}

/** Tushare fund_basic 行（ETF 目录） */
export interface FundBasicRow {
  ts_code: string;
  name: string;
  management: string;
  fund_type: string;
  list_date: string;
  status: string;
  market: string;
}

/** PCF 归一化行（沪深统一） */
export interface PcfNormalizedRow {
  tsCode: string;
  tradeDate: string;
  fundName: string;
  manager: string;
  fundType: string;
  indexCode: string;
  creationUnit: number | null;
  maxCashRatio: number | null;
  publishIopv: boolean;
  conCode: string;
  conName: string;
  quantity: number | null;
  substFlag: string;
  premiumRate: number | null;
  discountRate: number | null;
}

/** PCF 查询行（前端展示） */
export interface EtfPcfDetailRow {
  tsCode: string;
  tradeDate: string;
  conCode: string;
  conName: string | null;
  quantity: string | null;
  substFlag: string | null;
  premiumRate: string | null;
  discountRate: string | null;
}

/** ETF 最新列表行 */
export interface EtfLatestRow {
  tsCode: string;
  name: string;
  exchange: string;
  fundType: string | null;
  manager: string | null;
  indexCode: string | null;
  publishIopv: boolean;
  tradeDate: string | null;
  close: number | null;
  pctChange: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  kdjK: number | null;
  kdjD: number | null;
  kdjJ: number | null;
  obv5d: number | null;
  obv10d: number | null;
  obv20d: number | null;
  creationUnit: string | null;
  maxCashRatio: string | null;
  componentCount: number | null;
}

/** ETF K 线行（喂 K 线图） */
export interface EtfKlineRow {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  pre_close: number;
  pct_chg: number | null;
  MA5: number | null;
  MA30: number | null;
  MA60: number | null;
  MA120: number | null;
  MA240: number | null;
  DIF: number | null;
  DEA: number | null;
  MACD: number | null;
  'KDJ.K': number | null;
  'KDJ.D': number | null;
  'KDJ.J': number | null;
  BBI: number | null;
  ATR14: number | null;
  ROC10: number | null;
  ROC20: number | null;
  ROC60: number | null;
  brick: number | null;
  brick_delta: number | null;
  brick_xg: boolean | null;
  /** 活跃市值副图（raw.fund_amv_daily join；null = 当日无 AMV 数据） */
  '0AMV'?: number | null;
  '0AMV.DIF'?: number | null;
  '0AMV.DEA'?: number | null;
  '0AMV.MACD'?: number | null;
}

/** ETF AMV 行 */
export interface EtfAmvSyncRow {
  tsCode: string;
  tradeDate: string;
  netAmount: number | null;
  buyLgAmount: number | null;
  buyMdAmount: number | null;
  buySmAmount: number | null;
}

/** AMV daily row (amv-sync-helpers compatible) */
export interface EtfAmvDailyRow {
  tsCode: string;
  tradeDate: string;
  amvOpen: number;
  amvHigh: number;
  amvLow: number;
  amvClose: number;
  amvDif: number;
  amvDea: number;
  amvMacd: number;
  amvZdf: number;
  signal: number;
  memberCount: number | null;
}

/** ETF 资金净流入查询结果 */
export interface EtfLatestResult {
  rows: EtfLatestRow[];
  total: number;
}
