/** 自定义指数计算共享类型（port quant_pipeline/custom_index/types.py） */

export interface MemberWeight {
  conCode: string;
  weight: number;
}

export interface WeightVersion {
  id: number;
  effectiveDate: string;
  expireDate: string | null;
  weightMethod: string;
  members: readonly MemberWeight[];
}

export interface StockMeta {
  listDate: string | null;
  delistDate: string | null;
}

/** 单日单成分行情（已含用于指数计算的价位） */
export interface ComponentBar {
  conCode: string;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  preClose: number | null;
  vol: number | null;
  amount: number | null;
  price: number;
  pricePrev: number | null;
  pricePrevRaw: number | null;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  adjFactor?: number | null;
  adjFactorPrev?: number | null;
}

export interface IndexQuoteRow {
  tradeDate: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  preClose?: number | null;
  change?: number | null;
  pctChange?: number | null;
  volHand?: number | null;
  amount?: number | null;
}

/** 内存态：成分行情 + 复权 + 元数据 */
export interface ComputeContext {
  tradeDates: string[];
  barsByDate: Record<string, Record<string, ComponentBar>>;
  stockMeta: Record<string, StockMeta>;
  adjLatest: Record<string, number>;
  warnings: Array<{ code: string; detail: Record<string, unknown> }>;
}

export interface CustomIndexMoneyFlowRow {
  customIndexId: string;
  tradeDate: string;
  netAmount: number | null;
  buyLgAmount: number | null;
  buyMdAmount: number | null;
  buySmAmount: number | null;
}

export interface CustomIndexAmvRow {
  customIndexId: string;
  tradeDate: string;
  amv: number;
  amvMa5: number | null;
  amvMa10: number | null;
  amvMa20: number | null;
  amvMa60: number | null;
}

export type CustomIndexWarningHandler = (
  code: string,
  detail: Record<string, unknown>,
) => void;

/** AMV 与行业 AMV calcAmvSeries MULT 对齐 */
export const CUSTOM_INDEX_AMV_SCALE_K = 0.1;
