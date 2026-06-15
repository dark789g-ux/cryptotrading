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
import type { StrategyConditionItem } from './strategyConditions'

// ── 配置类型（与后端 portfolio-sim.types.ts 对齐）────────────────────────────

export type PortfolioRankField = 'pos_120' | 'circ_mv' | 'none'
export type PortfolioRankDir = 'asc' | 'desc'

/**
 * 多因子排序的因子 KEY 联合（9 值，与后端 portfolio-sim.types.ts 的 RankFactorKey
 * 及 portfolio-sim.factor-registry.ts 注册表 keys 逐字段镜像）。
 */
export type PortfolioRankFactorKey =
  | 'pos_120'
  | 'pos_60'
  | 'close_ma60_ratio'
  | 'vol_ratio_60'
  | 'vol_ratio_120'
  | 'risk_reward'
  | 'momentum_60'
  | 'circ_mv'
  | 'ml_score'

/** 单个排序因子：因子 KEY + 权重 + 方向（镜像后端 RankFactor）。 */
export interface RankFactor {
  /** 因子 KEY（注册表白名单内）。 */
  factor: PortfolioRankFactorKey
  /** 该因子在 composite 综合分中的权重（>0）。 */
  weight: number
  /** 排序方向：asc=值小者优先、desc=值大者优先。 */
  dir: PortfolioRankDir
}

/**
 * 排序规格：因子数组（镜像后端 RankSpec）。
 * [] = none（按 ts_code 升序）、len1 = 单因子、len>1 = composite 多因子加权。
 */
export interface RankSpec {
  factors: RankFactor[]
}

/**
 * 动态仓位配置（Phase 2，镜像后端 SizingConfig）。缺省 = fixed（固定 positionRatio）。
 * fixed 不读 floorMult/capMult/kellyFraction/kellyMaxMult 字段。
 */
export interface SizingConfig {
  /** 仓位模式。缺省 'fixed'。 */
  mode: 'fixed' | 'signal_weighted' | 'source_kelly'
  /** signal_weighted 最差信号乘子，默认 0.5（须 >0）。 */
  floorMult: number
  /** signal_weighted 最优信号乘子，默认 1.5（须 ≥ floorMult）。 */
  capMult: number
  /** source_kelly half-kelly 系数，默认 0.5，范围 (0,1]。 */
  kellyFraction: number
  /** source_kelly 乘子上限，默认 1.0，范围 (0,∞)。 */
  kellyMaxMult: number
}

/**
 * 账户级熔断配置（Phase 3，镜像后端 CircuitBreaker）。缺省 = 全关。
 * 连亏熔断（cooldown）+ 回撤熔断（drawdown）双触发，anchorMode 下强制全旁路。
 */
export interface CircuitBreaker {
  /** 连亏熔断开关。 */
  enableCooldown: boolean
  /** 连亏 N 笔触发，正整数。 */
  consecutiveLossesThreshold: number
  /** 基础冷却交易日数。 */
  baseCooldownDays: number
  /** 冷却上限（≥ base）。 */
  maxCooldownDays: number
  /** 每次亏损延长天数（非负整数）。 */
  extendOnLoss: number
  /** 每次盈利缩短天数（非负整数）。 */
  reduceOnProfit: number
  /** 回撤熔断开关。 */
  enableDrawdownHalt: boolean
  /** 自峰值回撤 ≥ 此值停开仓，如 0.15。 */
  drawdownHaltPct: number
  /** 回升到回撤 ≤ 此值恢复（滞回），须 ≤ haltPct。 */
  drawdownResumePct: number
}

/**
 * 一条 regime 调仓规则（账户级，镜像后端 RegimeRule）。
 * 条件命中（内部 AND）时覆盖所有源的 maxPositions/positionRatio。
 * 条件用大盘 0AMV 字段（oamv_dif/oamv_dea/oamv_macd/oamv_close/oamv_ma240），
 * 算子限 gt/lt/gte/lte/eq/neq（禁上穿/下穿）；非 0AMV 字段 / 非法算子后端会 400 拒。
 */
export interface RegimeRule {
  /** 0AMV 条件列表（内部 AND，非空由后端校验保证）。复用条件项类型（compareMode 后端忽略）。 */
  conditions: StrategyConditionItem[]
  /** 命中时每源最大同时在仓数（正整数，无「不限仓 null」档）。 */
  maxPositions: number
  /** 命中时单票仓位占 NAV_ref，(0,1]。 */
  positionRatio: number
}

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
  /** 【保留 legacy】同日候选超额排序字段；'none' = 不排序。 */
  rankField: PortfolioRankField
  /** 【保留 legacy】排序方向（rankField !== 'none' 时有意义）。 */
  rankDir: PortfolioRankDir
  /** 【新增】多因子排序规格；存在且 factors 非空 → 接管排序（优先于 rankField）。 */
  rankSpec?: RankSpec
  /** 【新增】动态仓位配置（Phase 2）；缺省 = fixed。 */
  sizing?: SizingConfig
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
  /** 【新增】账户级熔断（Phase 3）；缺省 = 全关。anchorMode 下强制全旁路。 */
  circuitBreaker?: CircuitBreaker
  /**
   * 【新增 M1】账户级 regime 调仓（按当日大盘 0AMV 切 maxPositions/positionRatio）。
   * 缺省 / 空 = 零漂移（走源静态值）；配了之后未命中市场状态当天不开仓。anchorMode 下旁路。
   */
  regimes?: RegimeRule[]
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
  | 'cooldown' // 【Phase 3】连亏熔断冷却期内冻结开仓
  | 'drawdown_halt' // 【Phase 3】回撤熔断停开仓
  | 'sized_out' // 【Phase 2】source_kelly 负期望源 alloc≈0

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
  /**
   * 【新增】综合排序分 / 单因子值（后端 numeric 列 → string | null）。
   * composite=综合分、单因子=该因子值、none=null；老 run 为 null（降级）。
   */
  rankScore: string | null
  /**
   * 【新增】逐因子原始值 {factorKey: value|null}（后端 jsonb 列）。
   * taken/skipped 都带（含熔断冻结 skip 的笔）；老 run 为 null（降级）。
   */
  factorValues: Record<string, number | null> | null
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
