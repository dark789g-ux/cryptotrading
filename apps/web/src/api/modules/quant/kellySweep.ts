/**
 * Kelly Sweep API client
 *
 * Endpoints (global prefix /api):
 *   POST   /quant/jobs                              发起扫描（复用 quantApi.createJob）
 *   GET    /quant/kelly-sweep/meta                  字段白名单 + 出场族 + RS 基准
 *   GET    /quant/kelly-sweep/history               历史 job 列表
 *   GET    /quant/kelly-sweep/runs/:jobId/summary   结果摘要 + job 元信息
 *   GET    /quant/kelly-sweep/runs/:jobId/scatter   帕累托散点数据
 *   GET    /quant/kelly-sweep/runs/:jobId/topk      top-K 排行分页
 *   GET    /quant/kelly-sweep/runs/:jobId/rows      全量行分页
 *   GET    /quant/kelly-sweep/runs/:jobId/rows/:id  单行详情
 */
import { API_BASE, request } from '../../client'
import { appendQueryParam } from '../../query'
import { quantApi, type JobRow } from '../quant'

// ---------- 类型定义 ----------

export type SweepGroup = 'with_rs' | 'no_rs'

export type BaseTriggerOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq'

export type ExitFamily = 'fixed_n' | 'tp_sl' | 'trailing' | 'atr_stop'

export type SameDayRule = 'sl_first' | 'tp_first'

export interface BaseTrigger {
  field: string
  op: BaseTriggerOp
  value: number
}

/**
 * band_lock 出场族候选集（各维度多值），提交时拼进 job.params.band_lock_grid。
 *
 * 键名与 Python worker `_normalize_band_lock_candidates`（kelly_sweep_runner.py:104-129）
 * 透传给 `build_band_lock_grid(**candidates)` 的 5 个 kwargs 一一对应（必须带 `_list` 后缀）。
 * 每个值是该维度的候选集数组；后端做笛卡尔积 + 坍缩去重（sweep.py build_band_lock_grid）。
 *
 * 注意：band_lock 不属于 exit_families 合法集 {fixed_n,tp_sl,trailing,atr_stop}（NestJS DTO
 * KELLY_SWEEP_EXIT_FAMILIES 不放行）。band_lock 段是否生效**仅由本字段是否存在驱动**：
 * 传 band_lock_grid → Python 生成 band_lock 段并合并；不传 → 现状（无 band_lock）。
 */
export interface BandLockGrid {
  /** max_hold 候选：null=不封顶 / 正整数 */
  max_hold_list: (number | null)[]
  /** stop_ratio 候选（量化前原始 ratio，∈[0.001,1.0]，千分位） */
  stop_ratio_list: number[]
  /** floor_ratio 候选（量化前原始 ratio，∈[0.001,9.999]，千分位） */
  floor_ratio_list: number[]
  /** floor_enabled 候选（bool 多选） */
  floor_enabled_list: boolean[]
  /** ma5_require_down 候选（bool 多选） */
  ma5_require_down_list: boolean[]
}

/**
 * phase_lock 出场族候选集（各维度多值），提交时拼进 job.params.phase_lock_grid。
 *
 * 键名与 Python worker `_normalize_phase_lock_candidates`（kelly_sweep_runner.py，D4 实现）
 * 透传给 `build_phase_lock_grid(**candidates)` 的 3 个 kwargs 一一对应（必须带 `_list` 后缀）。
 * 每个值是该维度的候选集数组；后端做笛卡尔积 lookback × init_factor × lock_factor + 量化去重
 * （sweep.py build_phase_lock_grid）。
 *
 * 注意：phase_lock 不属于 exit_families 合法集 {fixed_n,tp_sl,trailing,atr_stop}（NestJS DTO
 * KELLY_SWEEP_EXIT_FAMILIES 不放行）。phase_lock 段是否生效**仅由本字段是否存在驱动**（与
 * band_lock 同 presence-driven）：传 phase_lock_grid → Python 生成 phase_lock 段并合并；
 * 不传 → 现状（无 phase_lock）。
 */
export interface PhaseLockGrid {
  /** lookback 候选（正整数，∈[1,250]，初始止损回看根数） */
  lookback_list: number[]
  /** init_factor 候选（量化前原始 ratio，∈(0,2.0]，千分位） */
  init_factor_list: number[]
  /** lock_factor 候选（量化前原始 ratio，∈(0,2.0]，千分位） */
  lock_factor_list: number[]
}

export interface SweepParams {
  base_trigger: BaseTrigger
  /** 'all' 或 ts_code 数组 */
  universe: 'all' | string[]
  /** YYYYMMDD */
  train_range: [string, string]
  /** YYYYMMDD */
  valid_range: [string, string]
  max_window: number
  max_entry_filters: number
  min_samples: number
  bootstrap_iters: number
  rs_lookback: number
  top_k: number
  same_day_rule: SameDayRule
  rs_benchmark: string[]
  exit_families: ExitFamily[]
  /**
   * band_lock 出场族候选集（可选）。
   * 仅当用户勾选「波段跟踪止损」出场族时存在并提交；不存在 = 不扫 band_lock（现状）。
   */
  band_lock_grid?: BandLockGrid
  /**
   * phase_lock 出场族候选集（可选）。
   * 仅当用户勾选「分阶段锁定止损」出场族时存在并提交；不存在 = 不扫 phase_lock（现状）。
   */
  phase_lock_grid?: PhaseLockGrid
}

export interface KellySweepMeta {
  base_fields: string[]
  exit_families: ExitFamily[]
  rs_benchmarks: string[]
}

export interface KellyHistoryItem extends JobRow {}

export interface KellyHistoryResponse {
  items: KellyHistoryItem[]
  total: number
  page: number
  pageSize: number
}

export interface KellyHistoryPage {
  rows: KellyHistoryItem[]
  total: number
  page: number
  pageSize: number
}

/** result_payload.best 字段（Python build_summary_payload 写入） */
export interface KellySweepResultPayloadBest {
  window_group: string
  variant_id: string
  exit_id: string
  kelly_valid: number
  kelly_ci_low: number | null
  kelly_ci_high: number | null
  n_valid: number
}

/** result_payload 结构（Python build_summary_payload 写入） */
export interface KellySweepResultPayload {
  n_rows: number
  n_topk: number
  n_frontier: number
  best: KellySweepResultPayloadBest | null
}

/**
 * getSummary 实际返回后端 job 元信息（ml.jobs 字段 snake_case 直出）
 * + result_payload（Python build_summary_payload 写入）。
 * 后端接口：GET /api/quant/kelly-sweep/runs/:jobId/summary
 */
export interface KellySweepSummary {
  id: string
  status: string
  progress: number
  stage: string | null
  run_type: string
  params: Record<string, unknown>
  result_payload: KellySweepResultPayload | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/** scatter 接口单点（后端 getScatter 显式映射，id 是 bigint-as-string） */
export interface KellyScatterPoint {
  id: string
  n_valid: number
  kelly_valid: number | null
  is_frontier: boolean
  below_floor: boolean
  variant_id: string
  exit_id: string
}

/**
 * top-K 行（getTopk 明确映射出参，以后端 TopkRow 接口为准）。
 * 字段名：snake_case，与后端 kelly-sweep.service.ts TopkRow 逐一对应。
 */
export interface KellyTopkRow {
  id: string
  variant_id: string
  exit_id: string
  n_valid: number
  kelly_valid: number | null
  kelly_ci_low: number | null
  kelly_ci_high: number | null
  win_rate_valid: number | null
  payoff_b_valid: number | null
  profit_factor_valid: number | null
  below_floor: boolean
  is_frontier: boolean
  same_day_rule: string
}

/**
 * 全量行（getRows 返回 KellySweepResult 实体，TypeORM camelCase 序列化）。
 * 字段名：camelCase，与 KellySweepResult entity 属性名对应。
 */
export interface KellyRow {
  id: string
  jobId: string
  windowGroup: string
  variantId: string
  variantFilters: [string, string, number][][]
  exitId: string
  exitCfg: Record<string, unknown>
  nTrain: number
  kellyTrain: number | null
  winRateTrain: number | null
  payoffBTrain: number | null
  profitFactorTrain: number | null
  nValid: number
  kellyValid: number | null
  winRateValid: number | null
  payoffBValid: number | null
  profitFactorValid: number | null
  belowFloor: boolean
  kellyCiLow: number | null
  kellyCiHigh: number | null
  isFrontier: boolean
  isTopk: boolean
  sameDayRule: string
  createdAt: string
}

/**
 * 单行完整字段（getRow 返回 KellySweepResult 实体，与 KellyRow 相同结构）。
 */
export interface KellyRowDetail extends KellyRow {}

export interface KellyPageResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// ---------- API ----------

export const kellySweepApi = {
  /**
   * 发起扫描。复用 quantApi.createJob，传 run_type='kelly_sweep'。
   */
  createSweepJob(params: SweepParams): Promise<JobRow> {
    return quantApi.createJob({ run_type: 'kelly_sweep', params: params as unknown as Record<string, unknown> })
  },

  /**
   * 获取 meta：字段白名单 + 出场族 + RS 基准。
   * GET /api/quant/kelly-sweep/meta
   */
  getMeta(): Promise<KellySweepMeta> {
    return request<KellySweepMeta>(`${API_BASE}/quant/kelly-sweep/meta`)
  },

  /**
   * 历史 job 列表（run_type='kelly_sweep'）。
   * GET /api/quant/kelly-sweep/history?status=&page=
   */
  async getHistory(params: { status?: string; page?: number } = {}): Promise<KellyHistoryPage> {
    const qs = new URLSearchParams()
    appendQueryParam(qs, 'status', params.status)
    appendQueryParam(qs, 'page', params.page)
    const s = qs.toString()
    const raw = await request<KellyHistoryResponse>(
      `${API_BASE}/quant/kelly-sweep/history${s ? `?${s}` : ''}`,
    )
    return {
      rows: raw.items ?? [],
      total: raw.total ?? 0,
      page: raw.page ?? params.page ?? 1,
      pageSize: raw.pageSize ?? 20,
    }
  },

  /**
   * 结果摘要 + job 元信息。
   * GET /api/quant/kelly-sweep/runs/:jobId/summary
   */
  getSummary(jobId: string): Promise<KellySweepSummary> {
    return request<KellySweepSummary>(
      `${API_BASE}/quant/kelly-sweep/runs/${encodeURIComponent(jobId)}/summary`,
    )
  },

  /**
   * 散点数据（group 必填，口径不可混）。
   * GET /api/quant/kelly-sweep/runs/:jobId/scatter?group=with_rs|no_rs
   */
  getScatter(jobId: string, group: SweepGroup): Promise<KellyScatterPoint[]> {
    const qs = new URLSearchParams({ group })
    return request<KellyScatterPoint[]>(
      `${API_BASE}/quant/kelly-sweep/runs/${encodeURIComponent(jobId)}/scatter?${qs.toString()}`,
    )
  },

  /**
   * top-K 排行分页。
   * GET /api/quant/kelly-sweep/runs/:jobId/topk?group=&page=&pageSize=&sort=
   */
  async getTopk(
    jobId: string,
    params: { group: SweepGroup; page?: number; pageSize?: number; sort?: string },
  ): Promise<{ rows: KellyTopkRow[]; total: number }> {
    const qs = new URLSearchParams({ group: params.group })
    appendQueryParam(qs, 'page', params.page)
    appendQueryParam(qs, 'pageSize', params.pageSize)
    appendQueryParam(qs, 'sort', params.sort)
    const raw = await request<KellyPageResponse<KellyTopkRow>>(
      `${API_BASE}/quant/kelly-sweep/runs/${encodeURIComponent(jobId)}/topk?${qs.toString()}`,
    )
    return { rows: raw.items ?? [], total: raw.total ?? 0 }
  },

  /**
   * 全量行分页。
   * GET /api/quant/kelly-sweep/runs/:jobId/rows?group=&page=&pageSize=&sort=
   */
  async getRows(
    jobId: string,
    params: { group: SweepGroup; page?: number; pageSize?: number; sort?: string },
  ): Promise<{ rows: KellyRow[]; total: number }> {
    const qs = new URLSearchParams({ group: params.group })
    appendQueryParam(qs, 'page', params.page)
    appendQueryParam(qs, 'pageSize', params.pageSize)
    appendQueryParam(qs, 'sort', params.sort)
    const raw = await request<KellyPageResponse<KellyRow>>(
      `${API_BASE}/quant/kelly-sweep/runs/${encodeURIComponent(jobId)}/rows?${qs.toString()}`,
    )
    return { rows: raw.items ?? [], total: raw.total ?? 0 }
  },

  /**
   * 单行完整字段（详情弹窗）。
   * GET /api/quant/kelly-sweep/runs/:jobId/rows/:rowId
   */
  getRowDetail(jobId: string, rowId: string): Promise<KellyRowDetail> {
    return request<KellyRowDetail>(
      `${API_BASE}/quant/kelly-sweep/runs/${encodeURIComponent(jobId)}/rows/${rowId}`,
    )
  },
}
