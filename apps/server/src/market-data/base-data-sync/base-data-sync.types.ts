// raw 基础数据（trade_cal / stk_limit / suspend_d）SSE 同步的 DTO 与事件类型。
// 对象键名一律英文（防 PowerShell GBK 解析中文裸键名报错）；源文件 UTF-8。

/** 同步请求参数（query 透传）。 */
export interface SyncDto {
  /** 起始交易日，8 位 YYYYMMDD */
  start_date: string;
  /** 结束交易日，8 位 YYYYMMDD */
  end_date: string;
  /**
   * 同步模式。后端不分支——incremental / overwrite 都走幂等 upsert，
   * 不做区间 DELETE；syncMode 仅供前端计算默认日期范围，后端可忽略其值。
   */
  syncMode?: 'incremental' | 'overwrite';
}

/**
 * 失败 / 空数据项。
 * apiName 取值：
 *  - 'trade_cal' / 'stk_limit' / 'suspend_d'：三方调用异常（含 message）
 *  - 'trade_cal_empty' / 'stk_limit_empty' / 'suspend_d_empty'：当日/范围返回 0 行（仅 params）
 *  - 'no_open_trade_dates'：范围内无开市日，跳过后两表（仅 params）
 */
export interface ErrorItem {
  apiName: string;
  params: Record<string, unknown>;
  message?: string;
}

/** 单次同步结果。 */
export interface SyncResult {
  /** 真实写入行数（去重后），0 行调用不计入 */
  success: number;
  /** 跳过数（后端不分支增量，恒 0，保留字段对齐范式） */
  skipped: number;
  /** 失败 / 空数据项 */
  errors: ErrorItem[];
}

/** SSE 进度事件。 */
export type SyncEvent =
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
      result: SyncResult;
    }
  | {
      type: 'error';
      message: string;
    };

/** 单表库存日期范围（min/max 为字符串或 null）。 */
export interface DateRange {
  min: string | null;
  max: string | null;
}

/** 三表库存范围，驱动前端增量默认与库存标签。 */
export interface StoredRange {
  stkLimit: DateRange;
  suspend: DateRange;
  tradeCal: DateRange;
}
