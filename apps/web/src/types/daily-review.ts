export type DailyReviewStatus = 'pending' | 'fetching' | 'generating' | 'completed' | 'failed'

export interface DailyReviewListItem {
  id: string
  tradeDate: string
  status: DailyReviewStatus
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type ProgressEvent =
  | { stage: 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'; percent: number; message?: string }
  | { stage: 'completed'; percent: 100 }
  | { stage: 'failed'; percent: number; error: string }

export const STAGE_LABEL: Record<ProgressEvent['stage'], string> = {
  validate: '校验数据',
  fetch: '采集数据',
  build: '构建快照',
  reasoning: 'AI 推理中',
  writing: 'AI 撰写中',
  finalize: '校验中',
  completed: '已完成',
  failed: '失败',
}
