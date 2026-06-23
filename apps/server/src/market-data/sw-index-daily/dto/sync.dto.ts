/**
 * GET /sw-index-daily/sync query 入参（与 ths-index-daily 同步 dto 同构）。
 */
export class SwIndexDailySyncDto {
  /** 起始日期 YYYYMMDD */
  start_date: string;
  /** 结束日期 YYYYMMDD */
  end_date: string;
  /** 同步模式：incremental（默认，跳过已同步交易日）| overwrite（覆盖写入） */
  syncMode?: 'incremental' | 'overwrite';
}
