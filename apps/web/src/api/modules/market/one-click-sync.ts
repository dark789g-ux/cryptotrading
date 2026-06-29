// apps/web/src/api/modules/market/one-click-sync.ts
//
// 「一键同步」后端托管编排 API client。后端 spec §4.1（均 @AdminOnly）：
//   POST /api/one-click-sync/runs           body {startDate,endDate}(YYYYMMDD) → Run（新建或复用 running）
//   GET  /api/one-click-sync/runs/active     → Run | null（无活跃返回最近一条/null）
//   GET  /api/one-click-sync/runs/:id        → Run（轮询单条进度）
//   POST /api/one-click-sync/runs/:id/cancel → Run（置 cancelRequested=true）
//
// 返回字段为驼峰（与后端实体序列化对齐）。steps[i] 的结构 = 前端现有 OneClickStepState，
// logs[i] = LogEntry（复用 components/sync/oneClickSync.types.ts，不重定义）。
// run 行顶层 startedAt/updatedAt/finishedAt 是 UTC 墙钟串 'YYYY-MM-DD HH:mm:ssZ'（带尾 Z）。

import { API_BASE, post, request } from '../../client'
import type {
  LogEntry,
  OneClickStepState,
} from '../../../components/sync/oneClickSync.types'

export type OneClickRunStatus = 'running' | 'success' | 'failed' | 'cancelled'

/** GET/POST /one-click-sync/runs[/:id] 返回的 run 实体（后端 camelCase 序列化）。 */
export interface OneClickSyncRun {
  id: string
  status: OneClickRunStatus
  /** YYYYMMDD 同步起 */
  startDate: string
  /** YYYYMMDD 同步止 */
  endDate: string
  /** 总进度 0-100（后端已算，前端直接用作 totalPercent）。 */
  progress: number
  /** 当前步索引 0..9；终态为 null。 */
  currentStep: number | null
  /** 10 步明细（结构 = 前端 OneClickStepState，长 10）。 */
  steps: OneClickStepState[]
  /** 滚动日志，上限 LOG_LIMIT（500）。 */
  logs: LogEntry[]
  /** 编排级失败原因。 */
  errorText: string | null
  cancelRequested: boolean
  createdBy: string | null
  /** UTC 墙钟串 'YYYY-MM-DD HH:mm:ssZ'（带尾 Z）。 */
  startedAt: string
  /** UTC 墙钟串 'YYYY-MM-DD HH:mm:ssZ'（带尾 Z），每次写回刷新。 */
  updatedAt: string
  /** UTC 墙钟串 'YYYY-MM-DD HH:mm:ssZ'（带尾 Z）；终态写入，否则 null。 */
  finishedAt: string | null
}

/** POST /one-click-sync/runs body（YYYYMMDD，本地 TZ 提取——禁 getUTC*）。 */
export interface StartOneClickSyncDto {
  startDate: string
  endDate: string
}

export const oneClickSyncApi = {
  /** POST /api/one-click-sync/runs 开始（单飞：已有 running 直接返回它）。 */
  startRun: (dto: StartOneClickSyncDto) =>
    post<OneClickSyncRun>(`${API_BASE}/one-click-sync/runs`, dto),

  /** GET /api/one-click-sync/runs/active 取活跃 run（无活跃返回最近一条或 null）。 */
  getActive: () =>
    request<OneClickSyncRun | null>(`${API_BASE}/one-click-sync/runs/active`),

  /** GET /api/one-click-sync/runs/:id 轮询单条进度。 */
  getRun: (id: string) =>
    request<OneClickSyncRun>(`${API_BASE}/one-click-sync/runs/${encodeURIComponent(id)}`),

  /** POST /api/one-click-sync/runs/:id/cancel 置 cancelRequested=true（返回更新后的 run）。 */
  cancelRun: (id: string) =>
    post<OneClickSyncRun>(`${API_BASE}/one-click-sync/runs/${encodeURIComponent(id)}/cancel`),
}
