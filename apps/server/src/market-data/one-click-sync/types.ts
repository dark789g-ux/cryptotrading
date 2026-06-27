// 「一键同步」后端编排器内部类型 + 前端契约镜像。
//
// 对象键名一律英文（防 PowerShell GBK 解析中文裸键名报错）；源文件 UTF-8。
//
// OneClickStepState / LogEntry / OneClickStepKey / OneClickStepStatus 与前端
//   apps/web/src/components/sync/oneClickSync.types.ts 逐字镜像（jsonb 落库结构对齐，
//   前端读库后能 1:1 重建那套富 UI）。Run 是 controller 出参（camelCase JSON）。

/** 11 个同步步骤的稳定 key（0-based 顺序对齐 STEP_ORDER）。 */
export type OneClickStepKey =
  | 'base-data'
  | 'a-shares'
  | 'money-flow'
  | 'ths-index-daily'
  | 'sw-index-daily'
  | 'market-index-daily'
  | 'stock-amv'
  | 'industry-amv'
  | 'concept-amv'
  | 'sw-amv'
  | 'oamv';

export type OneClickStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

/** 步骤级错误/警告项（对齐前端 OneClickErrorItem）。 */
export interface OneClickErrorItem {
  step: OneClickStepKey;
  level: 'info' | 'warn' | 'error';
  apiName?: string;
  message: string;
}

/** 单步明细（jsonb 数组元素；步骤级 startedAt/finishedAt 是 epoch ms）。 */
export interface OneClickStepState {
  step: OneClickStepKey;
  status: OneClickStepStatus;
  percent: number;
  phase: string;
  message: string;
  rowsWritten: number;
  errors: OneClickErrorItem[];
  startedAt: number | null;
  finishedAt: number | null;
}

/** 滚动日志单条（ts 是 epoch ms）。 */
export interface LogEntry {
  ts: number;
  step: OneClickStepKey | 'system';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type OneClickRunStatus = 'running' | 'success' | 'failed' | 'cancelled';

/**
 * controller 出参（camelCase JSON）。
 * 时间列 startedAt/updatedAt/finishedAt 是 UTC 墙钟串（formatUtcWallClock，带 Z 后缀）；
 * 步骤级时间在 steps[*].startedAt/finishedAt 里是 epoch ms（刻意不同源，见 spec §3.1）。
 */
export interface OneClickSyncRunDto {
  id: string;
  status: OneClickRunStatus;
  startDate: string;
  endDate: string;
  progress: number;
  currentStep: number | null;
  steps: OneClickStepState[];
  logs: LogEntry[];
  errorText: string | null;
  cancelRequested: boolean;
  createdBy: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** 步骤顺序（索引即 current_step 值；UI 显示为「1.~11.」）。 */
export const STEP_ORDER: OneClickStepKey[] = [
  'base-data',
  'a-shares',
  'money-flow',
  'ths-index-daily',
  'sw-index-daily',
  'market-index-daily',
  'stock-amv',
  'industry-amv',
  'concept-amv',
  'sw-amv',
  'oamv',
];

/** 滚动日志上限（与前端 LOG_LIMIT 一致）。 */
export const LOG_LIMIT = 500;

/** 进度事件最多每 ~1s 落一次库（节流刷 DB）。 */
export const DB_FLUSH_THROTTLE_MS = 1000;

/** 初始化 11 个 pending 步骤（buildInitialSteps 的后端等价）。 */
export function buildInitialSteps(): OneClickStepState[] {
  return STEP_ORDER.map((step) => ({
    step,
    status: 'pending' as OneClickStepStatus,
    percent: 0,
    phase: '',
    message: '',
    rowsWritten: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
  }));
}
