/**
 * 量化模型评分看板 API client
 *
 * URL / 字段命名严格对齐 Part J 实际落地的 NestJS 只读 controller：
 *   - apps/server/src/modules/quant/controllers/quant-scores.controller.ts
 *   - apps/server/src/modules/quant/controllers/quant-runs.controller.ts
 *   - apps/server/src/modules/quant/controllers/quant-quality.controller.ts
 *
 * J 是契约权威。本文件以 J 的响应 schema 为准；K 内部沿用的 camelCase
 * 命名（如 `pageSize`）在本文件内部做一层 adapter，避免侵入 view 层既有调用。
 *
 * 真实 endpoint（global prefix `/api`）：
 *   GET /api/quant/scores/daily              当日 ranked Top-K
 *   GET /api/quant/scores/ts/:ts_code        单股票评分时间序列
 *   GET /api/quant/scores/model-versions     可用 model_version 列表
 *   GET /api/quant/scores/compare            多模型同日对照
 *   GET /api/quant/runs                      训练 run 分页列表
 *   GET /api/quant/runs/:id                  训练 run 详情
 *   GET /api/quant/quality/:date             当日数据质量报告
 *   GET /api/quant/quality/recent            最近 N 日数据质量报告
 */
import { API_BASE, request } from '../client'
import { appendQueryParam } from '../query'

// ---------- 后端原始响应类型（与 J 服务端字段名 1:1） ----------

/** `/quant/scores/daily` items[] 与 `/quant/scores/compare` groups[].rows[] 共用结构 */
export interface ScoreRow {
  trade_date: string           // YYYYMMDD
  ts_code: string
  model_version: string
  score: number
  rank_in_day: number
  /** 后端目前不返回；保留可选字段，供未来 join raw 表后透出股票名 */
  name?: string | null
}

export interface ScoreSeriesPoint {
  trade_date: string
  score: number
  rank_in_day: number
}

export interface ModelVersionInfo {
  model_version: string
  /** UTC 墙钟字符串 `YYYY-MM-DD HH:mm:ssZ`（J: formatUtcWallClock） */
  created_at: string
  /** J 不返回，保留兼容字段 */
  feature_set_id?: string
  has_scores?: boolean
}

/** `/quant/scores/compare` groups[]：J 字段名为 `groups`，保留入参 model_versions 顺序 */
export interface CompareGroup {
  model_version: string
  rows: ScoreRow[]
}

/** J `/quant/runs` items[] 中的核心 OOS 指标，键已 snake_case 化 */
export interface OosMetricsCore {
  ndcg_at_5: number | null
  ndcg_at_10: number | null
  ic: number | null
  rank_ic: number | null
  portfolio_annual_after_cost: number | null
}

/** `/quant/runs` 列表行（list 视图无 hyperparams / oos_metrics 全量字段） */
export interface ModelRunListItem {
  id: string
  model_version: string
  feature_set_id: string
  artifact_uri: string
  report_uri: string | null
  created_at: string
  oos_metrics_core: OosMetricsCore
}

/** `/quant/runs/:id` 详情：list 字段 + 完整 jsonb + job_id / shap_uri */
export interface ModelRunDetail extends ModelRunListItem {
  job_id: string | null
  hyperparams: Record<string, unknown>
  oos_metrics: Record<string, unknown>
  shap_uri: string | null
}

/** J `/quant/runs` 实际响应（snake_case `page_size`） */
export interface RunListResponseRaw {
  items: ModelRunListItem[]
  total: number
  page: number
  page_size: number
}

/** K 内部使用的分页响应（camelCase `pageSize`，list view 不需要改） */
export interface ModelRunPage {
  rows: ModelRunListItem[]
  total: number
  page: number
  pageSize: number
}

export interface QualityItem {
  id: number
  trade_date: string
  level: 'info' | 'warn' | 'critical'
  rule: string
  detail: Record<string, unknown>
  created_at: string
}

// ---------- 查询参数 ----------

export interface ScoreQuery {
  trade_date: string
  model_version: string
  top_k?: number
}

/** K 调用方传 camelCase，client 内部映射为 J 的 `page_size` + `sort_by`。 */
export interface RunsQuery {
  page?: number
  pageSize?: number
  /** model_version 精确匹配 */
  model_version?: string
  /** J 仅允许 `created_at` / `model_version`；其它字段会被 J 校验 400 拒绝 */
  sortField?: 'created_at' | 'model_version'
  sortOrder?: 'ASC' | 'DESC'
}

// ---------- API ----------

export const quantApi = {
  /** 当日 ranked Top-K 评分。J: `GET /quant/scores/daily` */
  async getDailyTopK(params: ScoreQuery): Promise<{ rows: ScoreRow[]; total: number }> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'trade_date', params.trade_date)
    appendQueryParam(qs, 'model_version', params.model_version)
    appendQueryParam(qs, 'top_k', params.top_k)
    const res = await request<{
      trade_date: string
      model_version: string
      top_k: number
      items: ScoreRow[]
    }>(`${API_BASE}/quant/scores/daily?${qs.toString()}`)
    // J 不返回 total；列表是按 top_k 截断后的，前端把行数当 total 用即可
    return { rows: res.items ?? [], total: (res.items ?? []).length }
  },

  /** 单股票评分时间序列。J: `GET /quant/scores/ts/:ts_code` */
  async getScoreTimeSeries(params: {
    ts_code: string
    model_version: string
    start: string
    end: string
  }): Promise<{ points: ScoreSeriesPoint[] }> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'model_version', params.model_version)
    appendQueryParam(qs, 'start', params.start)
    appendQueryParam(qs, 'end', params.end)
    const res = await request<{
      ts_code: string
      model_version: string
      start: string
      end: string
      items: ScoreSeriesPoint[]
    }>(`${API_BASE}/quant/scores/ts/${encodeURIComponent(params.ts_code)}?${qs.toString()}`)
    return { points: res.items ?? [] }
  },

  /** 可用 model_version 列表。J: `GET /quant/scores/model-versions` */
  getModelVersions(): Promise<{ items: ModelVersionInfo[] }> {
    return request<{ items: ModelVersionInfo[] }>(
      `${API_BASE}/quant/scores/model-versions`,
    )
  },

  /** 多模型同日对照。J: `GET /quant/scores/compare`，响应字段 `groups`（按入参顺序）。 */
  async compareModels(params: {
    trade_date: string
    model_versions: string[]
    top_k?: number
  }): Promise<{ trade_date: string; top_k: number; groups: CompareGroup[] }> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'trade_date', params.trade_date)
    qs.set('model_versions', params.model_versions.join(','))
    appendQueryParam(qs, 'top_k', params.top_k)
    return request<{
      trade_date: string
      top_k: number
      groups: CompareGroup[]
    }>(`${API_BASE}/quant/scores/compare?${qs.toString()}`)
  },

  /**
   * 训练 run 列表（分页 + 排序 + filter）。J: `GET /quant/runs`。
   * 调用方使用 K 的 camelCase 字段（pageSize / sortField / sortOrder），
   * 这里做一层 adapter 拼装成 J 期望的 `page_size` + `sort_by=field:DIR`。
   * 响应同样把 `items` → `rows`、`page_size` → `pageSize`。
   */
  async listRuns(query: RunsQuery = {}): Promise<ModelRunPage> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'page', query.page)
    appendQueryParam(qs, 'page_size', query.pageSize)
    appendQueryParam(qs, 'model_version', query.model_version)
    if (query.sortField) {
      const dir = query.sortOrder ?? 'DESC'
      qs.set('sort_by', `${query.sortField}:${dir}`)
    }
    const s = qs.toString()
    const raw = await request<RunListResponseRaw>(
      `${API_BASE}/quant/runs${s ? `?${s}` : ''}`,
    )
    return {
      rows: raw.items ?? [],
      total: raw.total ?? 0,
      page: raw.page ?? query.page ?? 1,
      pageSize: raw.page_size ?? query.pageSize ?? 20,
    }
  },

  /** 单个训练 run 详情。J: `GET /quant/runs/:id` */
  getRun(id: string): Promise<ModelRunDetail> {
    return request<ModelRunDetail>(
      `${API_BASE}/quant/runs/${encodeURIComponent(id)}`,
    )
  },

  /** 当日质量报告。J: `GET /quant/quality/:date` */
  getQualityByDate(date: string): Promise<{ trade_date: string; items: QualityItem[] }> {
    return request<{ trade_date: string; items: QualityItem[] }>(
      `${API_BASE}/quant/quality/${encodeURIComponent(date)}`,
    )
  },

  /** 最近 N 日质量报告。J: `GET /quant/quality/recent` */
  getQualityRecent(
    days = 7,
    level?: 'info' | 'warn' | 'critical' | Array<'info' | 'warn' | 'critical'>,
  ): Promise<{ days: number; levels?: string[]; items: QualityItem[] }> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'days', days)
    if (Array.isArray(level)) {
      if (level.length > 0) qs.set('level', level.join(','))
    } else {
      appendQueryParam(qs, 'level', level)
    }
    return request<{ days: number; levels?: string[]; items: QualityItem[] }>(
      `${API_BASE}/quant/quality/recent?${qs.toString()}`,
    )
  },
}
