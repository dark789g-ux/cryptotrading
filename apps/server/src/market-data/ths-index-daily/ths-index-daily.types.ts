/**
 * Tushare ths_daily 同步任务的错误项。
 * 来源：
 *  - 三方调用异常（apiName='ths_daily', message=异常信息）
 *  - 当日返回 0 行（apiName='ths_daily_empty', message 不存在，仅 params）
 *  - 指标计算异常（apiName='ths_index_indicator', message=异常信息）
 */
export interface ThsIndexDailySyncErrorItem {
  apiName: string;
  params: Record<string, string | number>;
  message?: string;
}

/** 单次同步结果 */
export interface ThsIndexDailySyncResult {
  /** 落库 quote 行数（去重后） */
  success: number;
  /** 跳过的交易日数（增量模式下已同步过的） */
  skipped: number;
  /** 失败/空数据项 */
  errors: ThsIndexDailySyncErrorItem[];
}

/**
 * 大盘指数同步（index_daily）的错误项 apiName 枚举：
 *  - 'index_daily'         Tushare 调用异常
 *  - 'market_index_empty'  Tushare 返回 0 行（窗口内无数据）
 */
export interface MarketIndexSyncErrorItem {
  apiName: string;
  params: Record<string, string | number>;
  message?: string;
}

/** 大盘指数同步单次结果（结构对齐 ThsIndexDailySyncResult，便于前端统一渲染） */
export interface MarketIndexSyncResult {
  /** 落库 quote 行数（去重后） */
  success: number;
  /** 跳过的 (ts_code, trade_date) 行数（增量模式） */
  skipped: number;
  /** 失败/空数据项 */
  errors: MarketIndexSyncErrorItem[];
}

/** SSE 进度事件（与 ths-index-daily 同步事件同构） */
export type MarketIndexSyncEvent =
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
      result: MarketIndexSyncResult;
    }
  | {
      type: 'error';
      message: string;
      result?: MarketIndexSyncResult;
    };

/** SSE 进度事件（与 money-flow 风格一致，但用本模块独立类型） */
export type ThsIndexDailySyncEvent =
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
      result: ThsIndexDailySyncResult;
    }
  | {
      type: 'error';
      message: string;
      result?: ThsIndexDailySyncResult;
    };

/**
 * 查询 API GET /ths-index-daily 返回单行。
 * 字段命名与 a-shares getKlines() 的 AShareKlineRow 对齐，
 * 以便前端通用 KlineChart 组件直接消费。
 */
export interface ThsIndexDailyKlineRow {
  /** trade_date，原样 YYYYMMDD（不格式化为 YYYY-MM-DD，与 spec §4.4 对齐） */
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量：落库存「手」，输出转「股」（×100）以对齐 KlineChartBar.volume */
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
