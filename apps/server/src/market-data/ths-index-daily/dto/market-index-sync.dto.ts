/**
 * GET /ths-index-daily/market-sync/run query 入参。
 *
 * 大盘指数（000001.SH 等 8 个）走 Tushare `index_daily`，与行业/概念的 `ths_daily`
 * 不是同一接口，故独立 DTO + 独立路由。
 */
export class MarketIndexSyncDto {
  /** 起始日期 YYYYMMDD（可选，缺省走 catalog type='M' 范围内各指数最早可得日） */
  start_date?: string;
  /** 结束日期 YYYYMMDD（可选，缺省=今天） */
  end_date?: string;
  /** 同步模式：incremental（默认，跳过已入库的 (ts_code, trade_date)）| overwrite（覆盖） */
  syncMode?: 'incremental' | 'overwrite';
}
