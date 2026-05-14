// OvernightPayload 与 spec §4.3 对齐
// 该模块负责盘后/隔夜信息（美股指数、芯片股、中概股、大宗商品），
// 由 SnapshotBuilderService 在 Stage0 静态拉取。

export interface OvernightIndexQuote {
  name: string;
  close: number;
  pctChg: number;
  /** UTC 墙钟字符串（ISO8601），CLAUDE.md 时间规范 */
  quotedAt: string;
}

export interface OvernightStockQuote {
  ticker: string;
  pctChg: number;
  note?: string;
}

export interface OvernightCommodityQuote {
  name: string;
  price: number;
  unit: string;
  /** UTC 墙钟字符串（ISO8601），CLAUDE.md 时间规范 */
  quotedAt: string;
}

export interface OvernightPayload {
  usIndices: OvernightIndexQuote[];
  chipStocks: OvernightStockQuote[];
  chinaConcepts: OvernightStockQuote[];
  commodities: OvernightCommodityQuote[];
}
