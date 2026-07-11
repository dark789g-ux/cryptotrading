export class SyncFlowDto {
  /** 起始日期 YYYYMMDD */
  start_date: string;
  /** 结束日期 YYYYMMDD */
  end_date: string;
  /** 同步模式：incremental（默认，跳过已有日期）| overwrite（覆盖写入） */
  syncMode?: 'incremental' | 'overwrite';
  /** 取消信号（一键同步编排器注入，循环顶部检查 signal.aborted） */
  signal?: AbortSignal;
}
