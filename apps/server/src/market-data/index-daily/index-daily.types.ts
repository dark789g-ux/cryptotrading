/**
 * GET /api/indices/latest 单行。
 *
 * 每个指数取最新一行的 OHLC/pct_change/vol/amount/total_mv_wan。
 * 字段命名采用 camelCase（与 IndexCatalogRow / 前端 IndexLatestRow 对齐）。
 *
 * 设计 spec：docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md:159
 */
export interface IndexLatestRow {
  tsCode: string;
  name: string;
  category: 'market' | 'industry' | 'concept' | 'sw';
  /** 最新交易日 YYYYMMDD */
  tradeDate: string;
  close: number;
  pctChange: number | null;
  /** 成交量（手）—— 落库存「手」原样输出，不转「股」（与 K 线 volume 单位解耦） */
  vol: number | null;
  /** 成交额（千元），仅大盘有 */
  amount: number | null;
  /** 总市值（万元），仅行业/概念有 */
  totalMvWan: string | null;
  /** 市盈率（仅申万 category='sw' 填值） */
  pe: number | null;
  /** 市净率（仅申万 category='sw' 填值） */
  pb: number | null;
}

export interface IndexLatestResult {
  rows: IndexLatestRow[];
  total: number;
}

/**
 * K 线单行契约，与 ThsIndexDailyKlineRow 完全一致
 * （open_time=YYYYMMDD 字面串，volume 已 ×100 转「股」）。
 * 复用同一形状以便前端 KlineChart 通用消费。
 */
export interface IndexDailyKlineRow {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  MA5: number | null;
  MA30: number | null;
  MA60: number | null;
  MA120: number | null;
  MA240: number | null;
  'KDJ.K': number | null;
  'KDJ.D': number | null;
  'KDJ.J': number | null;
  DIF: number | null;
  DEA: number | null;
  MACD: number | null;
  BBI: number | null;
  brickChart?: { brick: number; delta: number; xg: boolean };
}
