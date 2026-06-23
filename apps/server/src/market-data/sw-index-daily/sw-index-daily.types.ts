/**
 * Tushare sw_daily / index_classify 同步任务的错误项。
 * 来源：
 *  - sw_daily 三方调用异常（apiName='sw_daily', message=异常信息）
 *  - 当日返回 0 行（apiName='sw_daily_empty', 仅 params）
 *  - index_classify 三方调用异常（apiName='index_classify', message=异常信息）
 *  - 指标计算异常（apiName='sw_index_indicator', message=异常信息）
 */
export interface SwIndexDailySyncErrorItem {
  apiName: string;
  params: Record<string, string | number>;
  message?: string;
}

/** 单次同步结果（与 ThsIndexDailySyncResult 同构） */
export interface SwIndexDailySyncResult {
  /** 落库 quote 行数（去重后） */
  success: number;
  /** 跳过的交易日数（增量模式下已同步过的） */
  skipped: number;
  /** 失败/空数据项 */
  errors: SwIndexDailySyncErrorItem[];
}

/** SSE 进度事件（与 ths-index-daily 同步事件同构） */
export type SwIndexDailySyncEvent =
  | {
      type: 'progress';
      phase: string;
      current: number;
      total: number;
      percent: number;
      message: string;
    }
  | {
      type: 'done';
      message: string;
      result: SwIndexDailySyncResult;
    }
  | {
      type: 'error';
      message: string;
      result?: SwIndexDailySyncResult;
    };
