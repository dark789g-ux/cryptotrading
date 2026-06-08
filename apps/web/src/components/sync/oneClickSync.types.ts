// 一键同步相关类型与常量（从 useOneClickSync.ts 抽出，保持单文件 ≤500 行）

export type OneClickStepKey =
  | 'base-data'
  | 'a-shares'
  | 'money-flow'
  | 'ths-index-daily'
  | 'stock-amv'
  | 'industry-amv'
  | 'concept-amv'
  | 'oamv'
export type OneClickStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface OneClickErrorItem {
  step: OneClickStepKey
  level: 'warn' | 'error'
  apiName?: string
  message: string
}

export interface OneClickStepState {
  step: OneClickStepKey
  label: string
  status: OneClickStepStatus
  percent: number
  phase: string
  message: string
  rowsWritten: number
  errors: OneClickErrorItem[]
  startedAt: number | null
  finishedAt: number | null
}

export interface LogEntry {
  ts: number
  step: OneClickStepKey | 'system'
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface OneClickSummary {
  steps: OneClickStepState[]
  totalMs: number
  errors: OneClickErrorItem[]
  cancelled: boolean
}

export interface OneClickMessageApi {
  error: (msg: string) => void
  success: (msg: string) => void
}

export const LOG_LIMIT = 500

export const STEP_LABELS: Record<OneClickStepKey, string> = {
  'base-data': '基础数据 (日历/涨跌停/停牌)',
  'a-shares': 'A 股数据',
  'money-flow': '资金流向',
  'ths-index-daily': '指数日线 (ths_daily)',
  'stock-amv': '个股 AMV',
  'industry-amv': '行业指数 AMV',
  'concept-amv': '板块（概念）AMV',
  oamv: '大盘 0AMV（中证全指）',
}

export function emptyStep(step: OneClickStepKey): OneClickStepState {
  return {
    step,
    label: STEP_LABELS[step],
    status: 'pending',
    percent: 0,
    phase: '',
    message: '',
    rowsWritten: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
  }
}

export function buildInitialSteps(): OneClickStepState[] {
  return [
    emptyStep('base-data'),
    emptyStep('a-shares'),
    emptyStep('money-flow'),
    emptyStep('ths-index-daily'),
    emptyStep('stock-amv'),
    emptyStep('industry-amv'),
    emptyStep('concept-amv'),
    emptyStep('oamv'),
  ]
}

// 日期 → YYYYMMDD（本地午夜，遵循 CLAUDE.md 日期选择器例外）
export function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
