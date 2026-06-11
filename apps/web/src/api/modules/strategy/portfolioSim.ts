/**
 * portfolioSim.ts —— 组合级模拟器（W3）前端 API 封装。
 *
 * 后端模块：apps/server/src/strategy-conditions/portfolio-sim/，路由前缀 /api/portfolio-sims，全部 AdminOnly。
 * numeric 字段后端返回 string | null，调用方一律 parseFloat 后再格式化（不在此层转换，保真透传）。
 *
 * 错误透传：底层 client.request 在非 2xx 时抛 ApiError，message 已是后端中文原文
 * （getErrorMessage 解析 body.message）。本模块不吞错、不二次包装，直接冒泡给 store/视图。
 */
import { API_BASE, post, del, request } from '../../client'

// ── 配置类型（与后端 portfolio-sim.types.ts 对齐）────────────────────────────

export type PortfolioRankField = 'pos_120' | 'circ_mv' | 'none'
export type PortfolioRankDir = 'asc' | 'desc'

/** 单个信号源（对应后端 PortfolioSimSource）。 */
export interface PortfolioSimSource {
  /** 既有 signal_test_run 的 id（completed 且 trades>0 才能纳入）。 */
  runId: string
  /** 人类可读标签；strategyExposure 的 key（须组内唯一）。 */
  label: string
  /** 单票权重占 NAV_ref，(0,1]。 */
  positionRatio: number
  /** 该策略最大同时在仓数；null = 不限。 */
  maxPositions: number | null
  /** 总敞口上限占 NAV_ref；null = 不限。 */
  exposureCap: number | null
  /** 同日候选超额排序字段；'none' = 不排序。 */
  rankField: PortfolioRankField
  /** 排序方向（rankField !== 'none' 时有意义）。 */
  rankDir: PortfolioRankDir
}

/** 交易成本费率（均为单边小数费率，与后端 PortfolioSimCostRates 对齐）。 */
export interface PortfolioSimCostRates {
  commissionPerSide: number
  transferPerSide: number
  stampSellBefore20230828: number
  stampSellFrom20230828: number
  slippagePerSide: number
}

/** 组合模拟整体配置（POST body 的 config 形状）。 */
export interface PortfolioSimConfig {
  sources: PortfolioSimSource[]
  initialCapital: number
  cost: PortfolioSimCostRates
  anchorMode: boolean
}

export interface CreatePortfolioSimDto {
  name: string
  note?: string | null
  config: PortfolioSimConfig
}

// ── 响应类型（与后端实体对齐；numeric → string | null）─────────────────────

export type PortfolioSimStatus = 'pending' | 'running' | 'success' | 'failed'
export type PortfolioSimPhase = 'loading' | 'replaying' | 'writing' | null

/** 锚点自校验结果（官方 vs 重放对账）。 */
export interface PortfolioSimAnchorCheck {
  pass: boolean
  kellyOfficial: number
  kellyReplayed: number
  winOfficial: number
  winReplayed: number
  nOfficial: number
  nReplayed: number
}

/** 组合模拟 run 实体（列表/详情共用）。 */
export interface PortfolioSimRun {
  id: string
  name: string
  note: string | null
  /** config 快照（后端落 jsonb，结构同提交时）。 */
  config: PortfolioSimConfig
  status: PortfolioSimStatus
  phase: PortfolioSimPhase
  progressDone: number
  progressTotal: number
  errorMessage: string | null
  finalNav: string | null
  totalRet: string | null
  annualRet: string | null
  maxDrawdown: string | null
  sharpe: string | null
  calmar: string | null
  dailyWinRate: string | null
  dailyKelly: string | null
  nTaken: number | null
  nSkipped: number | null
  totalCosts: string | null
  anchorCheck: PortfolioSimAnchorCheck | null
  createdAt: string
  completedAt: string | null
}

/** GET /:id/progress 响应（精简进度）。 */
export interface PortfolioSimProgress {
  status: PortfolioSimStatus
  phase: PortfolioSimPhase
  progressDone: number
  progressTotal: number
  errorMessage: string | null
}

/** GET /:id/daily 行（净值曲线 + 敞口）。 */
export interface PortfolioSimDailyRow {
  id: string
  runId: string
  tradeDate: string
  nav: string
  cash: string
  dailyRet: string
  exposure: string
  positionCount: number
  strategyExposure: Record<string, unknown>
}

export type PortfolioSimFillStatus = 'taken' | 'skipped'
export type PortfolioSkipReason =
  | 'already_held'
  | 'slots_full'
  | 'exposure_cap'
  | 'cash_short'

/** GET /:id/fills 行（逐信号明细）。 */
export interface PortfolioSimFill {
  id: string
  runId: string
  sourceRunId: string
  sourceLabel: string
  tsCode: string
  signalDate: string
  buyDate: string
  status: PortfolioSimFillStatus
  skipReason: PortfolioSkipReason | null
  rankField: string | null
  rankValue: string | null
  weightEntry: string | null
  alloc: string | null
  exitDate: string | null
  realizedRetNet: string | null
  costsPaid: string | null
}

export interface PortfolioSimListPage {
  total: number
  items: PortfolioSimRun[]
}

export interface PortfolioSimFillsPage {
  total: number
  items: PortfolioSimFill[]
}

/** fills 列表服务端排序白名单（与后端 FILL_SORT_COLUMN_MAP 一致）。 */
export type FillSortField =
  | 'sourceLabel'
  | 'tsCode'
  | 'signalDate'
  | 'buyDate'
  | 'status'
  | 'skipReason'
  | 'rankValue'
  | 'weightEntry'
  | 'alloc'
  | 'exitDate'
  | 'realizedRetNet'
  | 'costsPaid'

export interface ListFillsParams {
  page?: number
  pageSize?: number
  sortField?: FillSortField
  sortOrder?: 'asc' | 'desc'
  status?: PortfolioSimFillStatus
  sourceLabel?: string
  skipReason?: PortfolioSkipReason
  buyDateStart?: string
  buyDateEnd?: string
}

// ── API 对象 ───────────────────────────────────────────────────────────────

export const portfolioSimApi = {
  /** POST /api/portfolio-sims 新建方案（201 返实体）。 */
  create(data: CreatePortfolioSimDto) {
    return post<PortfolioSimRun>(`${API_BASE}/portfolio-sims`, data)
  },

  /** GET /api/portfolio-sims 分页列表（created_at 倒序）。 */
  findAll(page = 1, pageSize = 50) {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    return request<PortfolioSimListPage>(`${API_BASE}/portfolio-sims?${qs.toString()}`)
  },

  /** GET /api/portfolio-sims/:id 详情。 */
  findOne(id: string) {
    return request<PortfolioSimRun>(`${API_BASE}/portfolio-sims/${id}`)
  },

  /** POST /api/portfolio-sims/:id/run 触发（per-id 互斥 409 透传）。 */
  triggerRun(id: string) {
    return post<{ runId: string }>(`${API_BASE}/portfolio-sims/${id}/run`)
  },

  /** GET /api/portfolio-sims/:id/progress 进度。 */
  getProgress(id: string) {
    return request<PortfolioSimProgress>(`${API_BASE}/portfolio-sims/${id}/progress`)
  },

  /** GET /api/portfolio-sims/:id/daily 全量每日行（trade_date 升序）。 */
  listDaily(id: string) {
    return request<PortfolioSimDailyRow[]>(`${API_BASE}/portfolio-sims/${id}/daily`)
  },

  /** GET /api/portfolio-sims/:id/fills 服务端分页 + 筛选 + 排序。 */
  listFills(id: string, params: ListFillsParams = {}) {
    const qs = new URLSearchParams()
    qs.set('page', String(params.page ?? 1))
    qs.set('pageSize', String(params.pageSize ?? 50))
    if (params.sortField) {
      qs.set('sortField', params.sortField)
      qs.set('sortOrder', params.sortOrder ?? 'asc')
    }
    if (params.status) qs.set('status', params.status)
    if (params.sourceLabel) qs.set('sourceLabel', params.sourceLabel)
    if (params.skipReason) qs.set('skipReason', params.skipReason)
    if (params.buyDateStart) qs.set('buyDateStart', params.buyDateStart)
    if (params.buyDateEnd) qs.set('buyDateEnd', params.buyDateEnd)
    return request<PortfolioSimFillsPage>(
      `${API_BASE}/portfolio-sims/${id}/fills?${qs.toString()}`,
    )
  },

  /** DELETE /api/portfolio-sims/:id（running 中 409 透传）。 */
  remove(id: string) {
    return del<void>(`${API_BASE}/portfolio-sims/${id}`)
  },
}
