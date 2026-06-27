// 一键同步相关类型与常量（从 useOneClickSync.ts 抽出，保持单文件 ≤500 行）

import type { ComputedRef, Ref } from 'vue'

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
  | 'oamv'
export type OneClickStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface OneClickErrorItem {
  // step 放宽为 string：A 股传 OneClickStepKey，美股传 'us-stocks' 等，面板渲染 key-agnostic
  step: string
  level: 'warn' | 'error'
  apiName?: string
  message: string
}

export interface OneClickStepState {
  // step 放宽为 string：兼容 A 股 OneClickStepKey 与美股步骤 key（'us-stocks' 等）
  step: string
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
  // step 放宽为 string：覆盖 A 股 key、'system' 及美股步骤 key
  step: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface OneClickSummary {
  steps: OneClickStepState[]
  totalMs: number
  errors: OneClickErrorItem[]
  cancelled: boolean
}

/**
 * 一键同步面板（OneClickSyncPanel.vue）的 controller 接口。
 * A 股 useOneClickSync 与美股 useUsOneClickSync 共同实现，面板 prop 用它解耦具体 controller。
 */
export interface OneClickPanelController {
  dateRange: Ref<[number, number] | null>
  running: ComputedRef<boolean>
  steps: ComputedRef<OneClickStepState[]>
  totalPercent: ComputedRef<number>
  logEntries: ComputedRef<LogEntry[]>
  currentStepIndex: ComputedRef<number>
  elapsedMs: ComputedRef<number>
  summary: ComputedRef<OneClickSummary | null>
  canStart: ComputedRef<boolean>
  start: () => Promise<void>
  cancel: () => Promise<void>
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
  'sw-index-daily': '申万指数日线 (sw_daily)',
  'market-index-daily': '大盘指数日线 (index_daily)',
  'stock-amv': '个股 AMV',
  'industry-amv': '行业指数 AMV',
  'concept-amv': '板块（概念）AMV',
  'sw-amv': '申万指数 AMV',
  oamv: '大盘 0AMV（中证全指）',
}

export const US_STEP_LABELS: Record<string, string> = {
  'us-stocks': '美股个股',
  'us-index-daily': '美股指数日线',
  'us-index-amv': '美股指数 AMV',
}

/** 美股三步固定顺序（与后端 result_payload.steps 同序，用于空 payload 兜底）。 */
export const US_STEP_KEYS: readonly string[] = [
  'us-stocks',
  'us-index-daily',
  'us-index-amv',
]

/** 美股空步骤（pending 初始态，带 US_STEP_LABELS 补 label）。 */
export function emptyUsStep(step: string): OneClickStepState {
  return {
    step,
    label: US_STEP_LABELS[step] ?? '',
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

/** result_payload 为空/缺 steps 时的兜底：三步 pending（避免渲染空白）。 */
export function buildInitialUsSteps(): OneClickStepState[] {
  return US_STEP_KEYS.map(emptyUsStep)
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
    emptyStep('sw-index-daily'),
    emptyStep('market-index-daily'),
    emptyStep('stock-amv'),
    emptyStep('industry-amv'),
    emptyStep('concept-amv'),
    emptyStep('sw-amv'),
    emptyStep('oamv'),
  ]
}

// 日期 → YYYYMMDD（本地午夜，遵循 CLAUDE.md 日期选择器例外）
export function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
