export type DailyReviewStatus = 'pending' | 'fetching' | 'generating' | 'completed' | 'failed'

export interface DailyReviewListItem {
  id: string
  tradeDate: string
  status: DailyReviewStatus
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

// 与 spec §5 对齐：阶段、token、阶段耗时
export type Stage = 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'

export interface TokenUsage {
  prompt: number
  completion: number
  reasoning: number
  total: number
}

export interface StageTiming {
  stage: Stage
  // 遵循 CLAUDE.md 时间规范：UTC 墙钟字符串
  startedAt: string
  durationMs: number
}

// SSE 事件协议（spec §5）—— 判别联合
export type ProgressEvent =
  | { type: 'stage'; stage: Stage; percent: number; ts: number; message?: string }
  | { type: 'reasoning_delta'; text: string; ts: number }
  | { type: 'content_delta'; text: string; ts: number }
  | { type: 'usage'; tokens: TokenUsage; ts: number }
  | { type: 'stage_done'; stage: Stage; durationMs: number; ts: number }
  | { type: 'completed'; ts: number }
  | { type: 'failed'; error: string; ts: number }

// 详情接口（getDetail）响应——补齐 reasoning / article / timings / usage / model / errorMessage
export interface DailyReviewDetail {
  id: string
  tradeDate: string
  status: DailyReviewStatus
  errorMessage: string | null
  snapshot: any | null
  // 以下字段：admin 可见；非 admin 后端返回 null
  reasoningContent: string | null
  articleMd: string | null
  tokenUsage: TokenUsage | null
  llmModel: string | null
  // 所有用户可见（非敏感）
  stageTimings: StageTiming[] | null
  createdAt: string
  updatedAt: string
}

// 用于 STAGE_LABEL：阶段 + 终态（completed / failed 沿用旧 ProgressBar 兼容）
export type StageLabelKey = Stage | 'completed' | 'failed'

export const STAGE_LABEL: Record<StageLabelKey, string> = {
  validate: '校验数据',
  fetch: '采集数据',
  build: '构建快照',
  reasoning: 'AI 推理中',
  writing: 'AI 撰写中',
  finalize: '校验中',
  completed: '已完成',
  failed: '失败',
}
