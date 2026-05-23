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
import { API_BASE, patch, post, request } from '../client'
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

// ---------- M4: 作业 / SHAP 类型 ----------

export type JobRunType =
  | 'noop'
  | 'sync'
  | 'quality'
  | 'factors'
  | 'labels'
  | 'features'
  | 'train'
  | 'infer'
  | 'optuna'
  | 'seed_avg'
  | 'train_e2e'

export type JobStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'blocked'
  | 'cancelled'

/**
 * Job 运行期/历史回看产生的警告条目（PIT 窗口护门 spec 2026-05-23）。
 * 由 quant-pipeline runner 写入 `ml.jobs.warnings` JSONB 数组；
 * 详见 docs/superpowers/specs/2026-05-23-pit-window-guard-design/04-frontend-backend.md §4.1.5
 */
export interface WarningItem {
  /** 警告类型枚举（与 runner _emit_job_warning 写入对齐） */
  type:
    | 'factor_window_short'
    | 'factor_window_retry_failed'
    | 'trade_cal_not_synced'
  /** 产生时间，ISO UTC 字符串（runner 侧 datetime.utcnow().isoformat()+Z） */
  ts: string
  factor_id: string
  factor_version?: string
  trade_date?: string
  detail?: Record<string, unknown>
}

/** `ml.jobs` 一行（NestJS 出参字段；时间为 UTC 墙钟字符串） */
export interface JobRow {
  id: string
  run_type: JobRunType
  status: JobStatus
  progress: number
  stage: string | null
  priority: number
  attempts: number
  max_attempts: number
  cancel_requested: boolean
  parent_job_id: string | null
  params: Record<string, unknown>
  error_text: string | null
  blocked_reason: string | null
  created_by: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
  /**
   * job 期间累积的警告条目。GET /quant/jobs/:id 返回全量明细；
   * 列表 GET /quant/jobs 出于负载考虑通常只返 warnings_count。
   * 后端尚未上线时字段缺省，按空数组处理。
   */
  warnings?: WarningItem[]
  /** 列表接口仅返回的总数（不带明细），用于列表页打小红点 */
  warnings_count?: number
}

export interface JobListQuery {
  page?: number
  pageSize?: number
  status?: JobStatus[]
  run_type?: JobRunType[]
}

export interface JobListResponseRaw {
  items: JobRow[]
  total: number
  page: number
  page_size: number
}

export interface JobListPage {
  rows: JobRow[]
  total: number
  page: number
  pageSize: number
}

/** SHAP top-k 单条：feature_id + 平均 |SHAP| 值，按 importance 倒序 */
export interface ShapItem {
  feature_id: string
  importance: number
}

/** SSE NOTIFY payload（00-index §3 通信契约） */
export interface JobProgressEvent {
  job_id: string
  progress: number
  stage: string
}

// ---------- 因子清单（factor-registry-frontend，2026-05-23 spec） ----------

/**
 * `factors.factor_definitions` 行（DB 单一权威；契约采用 snake_case 与后端对齐）。
 * 详见 docs/superpowers/specs/2026-05-23-factor-registry-frontend-design/04-frontend.md
 */
export interface FactorDefinition {
  factor_id: string
  factor_version: string
  description: string
  formula: string | null
  /** 计算依赖的原始列名集合，仅供前端只读展示 */
  data_source: string[] | null
  category: 'price' | 'industry' | 'fundamental' | 'mixed'
  pit_window_days: number
  pit_anchor: 'trade_date' | 'ann_date'
  /**
   * 该因子计算所需的最小交易日数（契约不可改，由代码端维护）。
   * 前端编辑 pit_window_days 时用于实时校验 pit_window_days >= ceil(min_trade_days × 2.0)。
   * 详见 docs/superpowers/specs/2026-05-23-pit-window-guard-design/04-frontend-backend.md §4.1.3
   */
  min_trade_days: number
  enabled: boolean
  display_order: number
  /** UTC 墙钟字符串 */
  updated_at: string
  updated_by: string | null
}

/** PATCH 编辑负载（partial update；formula / data_source 由代码维护，不允许前端写） */
export interface UpdateFactorPatch {
  description?: string
  category?: FactorDefinition['category']
  pit_window_days?: number
  pit_anchor?: FactorDefinition['pit_anchor']
  enabled?: boolean
  display_order?: number
}

export interface ListFactorsQuery {
  enabled?: boolean
  category?: string
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

  // ============ M4 Part C：jobs / SSE / quality alerts 扩展 ============

  /**
   * 触发新作业（M2 已实现 `POST /quant/jobs`）。
   * 返回 NestJS 落库后的 job 行；前端拿 id 后跳 `/quant/jobs` 并高亮。
   */
  createJob(body: {
    run_type: JobRunType
    params: Record<string, unknown>
    priority?: number
    max_attempts?: number
  }): Promise<JobRow> {
    return post<JobRow>(`${API_BASE}/quant/jobs`, body)
  },

  /** 列表查询（按 status / run_type 过滤 + 分页）。M2: `GET /quant/jobs` */
  async listJobs(query: JobListQuery = {}): Promise<JobListPage> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'page', query.page)
    appendQueryParam(qs, 'page_size', query.pageSize)
    if (query.status && query.status.length > 0) {
      qs.set('status', query.status.join(','))
    }
    if (query.run_type && query.run_type.length > 0) {
      qs.set('run_type', query.run_type.join(','))
    }
    const s = qs.toString()
    const raw = await request<JobListResponseRaw>(
      `${API_BASE}/quant/jobs${s ? `?${s}` : ''}`,
    )
    return {
      rows: raw.items ?? [],
      total: raw.total ?? 0,
      page: raw.page ?? query.page ?? 1,
      pageSize: raw.page_size ?? query.pageSize ?? 20,
    }
  },

  /** 单个 job 详情（也用于 SSE 重连后的兜底回补当前 progress） */
  getJob(id: string): Promise<JobRow> {
    return request<JobRow>(`${API_BASE}/quant/jobs/${encodeURIComponent(id)}`)
  },

  /** 申请取消（NestJS 把 cancel_requested 写 true，worker 异步响应） */
  cancelJob(id: string): Promise<{ ok: true }> {
    return post<{ ok: true }>(`${API_BASE}/quant/jobs/${encodeURIComponent(id)}/cancel`)
  },

  /**
   * 为 SSE 申请 5 分钟短期 token；浏览器 EventSource 不带 Authorization header，
   * 走 query token 鉴权（03-nestjs-vue.md §1）。
   */
  issueSseToken(id: string): Promise<{ token: string; expires_at: string }> {
    return post<{ token: string; expires_at: string }>(
      `${API_BASE}/quant/jobs/${encodeURIComponent(id)}/sse-token`,
    )
  },

  /** 拼装 SSE URL（前端直接 `new EventSource(url)`） */
  buildSseUrl(id: string, token: string): string {
    const qs = new URLSearchParams({ token })
    return `${API_BASE}/quant/jobs/${encodeURIComponent(id)}/stream?${qs.toString()}`
  },

  /**
   * SHAP top-k JSON：`model_runs.shap_uri` 指向 artifact_uri 同目录下文件。
   * NestJS Part B 提供 `GET /quant/runs/:id/shap` 代理读 artifact，返回 `{ items: [...] }`。
   */
  async getRunShap(id: string): Promise<{ items: ShapItem[] }> {
    return request<{ items: ShapItem[] }>(
      `${API_BASE}/quant/runs/${encodeURIComponent(id)}/shap`,
    )
  },

  /** 当日质量报告（按 level 数组过滤；Overview 告警条只关心 critical） */
  getQuality(
    date: string,
    level?: Array<'info' | 'warn' | 'critical'>,
  ): Promise<{ trade_date: string; items: QualityItem[] }> {
    const qs = new URLSearchParams()
    if (level && level.length > 0) {
      qs.set('level', level.join(','))
    }
    const s = qs.toString()
    return request<{ trade_date: string; items: QualityItem[] }>(
      `${API_BASE}/quant/quality/${encodeURIComponent(date)}${s ? `?${s}` : ''}`,
    )
  },

  /** 当日质量报告。J: `GET /quant/quality/:date` */
  getQualityByDate(date: string): Promise<{ trade_date: string; items: QualityItem[] }> {
    return request<{ trade_date: string; items: QualityItem[] }>(
      `${API_BASE}/quant/quality/${encodeURIComponent(date)}`,
    )
  },

  // ============ 因子清单（factor-registry-frontend，2026-05-23 spec） ============

  /**
   * 列出全部因子定义。后端 `GET /quant/factors`，filter 在 query 上下放。
   * 返回字段 snake_case，对齐 DB 行。
   */
  listFactors(query: ListFactorsQuery = {}): Promise<{ items: FactorDefinition[] }> {
    const qs = new URLSearchParams()
    if (typeof query.enabled === 'boolean') {
      qs.set('enabled', query.enabled ? 'true' : 'false')
    }
    appendQueryParam(qs, 'category', query.category)
    const s = qs.toString()
    return request<{ items: FactorDefinition[] }>(
      `${API_BASE}/quant/factors${s ? `?${s}` : ''}`,
    )
  },

  /** 可用因子类别列表（用于筛选下拉）。后端 `GET /quant/factors/categories` */
  listFactorCategories(): Promise<{ items: string[] }> {
    return request<{ items: string[] }>(`${API_BASE}/quant/factors/categories`)
  },

  /**
   * 编辑一行因子。后端 `PATCH /quant/factors/:id/:version`。
   * 仅在下一次 train_e2e job 启动时生效（registry.reload_from_db）。
   */
  updateFactor(
    id: string,
    version: string,
    body: UpdateFactorPatch,
  ): Promise<{ item: FactorDefinition }> {
    return patch<{ item: FactorDefinition }>(
      `${API_BASE}/quant/factors/${encodeURIComponent(id)}/${encodeURIComponent(version)}`,
      body,
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
