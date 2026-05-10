export class SyncFlowDto {
  /** 起始日期 YYYYMMDD */
  start_date: string;
  /** 结束日期 YYYYMMDD */
  end_date: string;
  /** 同步模式：incremental（默认，跳过已有日期）| overwrite（覆盖写入） */
  syncMode?: 'incremental' | 'overwrite';
}
