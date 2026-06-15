import { API_BASE, post, put, del, request } from '../../client'
import type { StrategyConditionItem } from './strategyConditions'
import type {
  PortfolioSimCostRates,
  RankSpec,
  SizingConfig,
  CircuitBreaker,
  RegimeRule,
} from './portfolioSim'

export interface SignalTestUniverse {
  type: 'all' | 'list'
  tsCodes?: string[]
}

/**
 * 迷你回测配置（扁平单源 PortfolioSimConfig，与后端 SignalTestBacktestConfig 对齐）。
 * null/缺省 = 不跑回测层（信号质量层零漂移）。子类型复用 portfolioSim 镜像类型。
 */
export interface SignalTestBacktestConfig {
  /** 初始资金（首日 NAV_ref）。 */
  initialCapital: number
  /** 交易成本费率（单边）。 */
  cost: PortfolioSimCostRates
  /** 锚点模式：约束停用、费率全 0、每笔必 taken。 */
  anchorMode: boolean
  /** 单票权重占 NAV_ref，(0,1]。 */
  positionRatio: number
  /** 最大同时在仓数；null = 不限。 */
  maxPositions: number | null
  /** 总敞口上限占 NAV_ref；null = 不限。 */
  exposureCap: number | null
  /** 多因子排序规格；factors=[] → 不排序（按 ts_code 升序）。 */
  rankSpec: RankSpec
  /** 动态仓位配置；mode='fixed' = 固定 positionRatio。 */
  sizing: SizingConfig
  /** 账户级熔断；null = 全关。 */
  circuitBreaker: CircuitBreaker | null
  /**
   * 【新增 M1】账户级 regime 调仓（按当日大盘 0AMV 切 maxPositions/positionRatio）。
   * 缺省 / 空 = 零漂移；配了之后未命中市场状态当天不开仓。可选，缺省时不下发。
   */
  regimes?: RegimeRule[]
}

export type SignalTestExitMode = 'fixed_n' | 'strategy' | 'trailing_lock' | 'phase_lock'

/** 波段跟踪止损额外参数；null = 全默认（与后端 entity band_lock_params jsonb 对齐）。 */
export interface BandLockParams {
  stopRatio: number
  floorRatio: number
  floorEnabled: boolean
  ma5RequireDown: boolean
}

/** 阶段锁定额外参数；null = 全默认（与后端 entity phase_lock_params jsonb 对齐）。 */
export interface PhaseLockParams {
  initFactor: number
  lockFactor: number
  lookback: number
}

export interface SignalTest {
  id: string
  name: string
  buyConditions: StrategyConditionItem[]
  exitMode: SignalTestExitMode
  horizonN: number | null
  exitConditions: StrategyConditionItem[] | null
  maxHold: number | null
  bandLockParams: BandLockParams | null
  phaseLockParams: PhaseLockParams | null
  /** 迷你回测配置；null = 不跑回测层。 */
  backtestConfig: SignalTestBacktestConfig | null
  universe: SignalTestUniverse
  dateStart: string
  dateEnd: string
  createdAt: string
  updatedAt: string
}

export interface CreateSignalTestDto {
  name: string
  buyConditions: StrategyConditionItem[]
  exitMode: SignalTestExitMode
  horizonN?: number
  exitConditions?: StrategyConditionItem[]
  maxHold?: number
  // trailing_lock 专属，全默认时不送（后端存 null → 零漂移）
  stopRatio?: number
  floorRatio?: number
  floorEnabled?: boolean
  ma5RequireDown?: boolean
  // phase_lock 专属，全默认时不送（后端存 null → 零漂移）
  initFactor?: number
  lockFactor?: number
  lookback?: number
  universe: SignalTestUniverse
  dateStart: string
  dateEnd: string
  /** 迷你回测配置（可选）；缺省 / null = 不跑回测层（零漂移）。 */
  backtestConfig?: SignalTestBacktestConfig | null
}

export type UpdateSignalTestDto = Partial<CreateSignalTestDto>

export interface SignalTestRun {
  id: string
  testId: string
  status: 'running' | 'completed' | 'failed'
  progressScanned: number
  progressTotal: number
  phase: 'scanning' | 'simulating' | 'replaying' | 'writing' | null
  errorMessage: string | null
  sampleCount: number | null
  winRate: string | null
  avgWin: string | null
  avgLoss: string | null
  payoffRatio: string | null
  profitFactor: string | null
  kellyF: string | null
  avgHoldDays: string | null
  worstTradeRet: string | null
  bestTradeRet: string | null
  // ── 迷你回测层指标（均 nullable；null = 该 run 未跑回测层）──────────────────
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
  filteredCount: number
  createdAt: string
  completedAt: string | null
}

/** 迷你回测逐日净值曲线行（signal_test_equity，trade_date 升序；numeric → string）。 */
export interface SignalTestEquityRow {
  id: string
  runId: string
  tradeDate: string
  nav: string
  cash: string
  dailyRet: string
  exposure: string
  positionCount: number
}

export interface RetHistogramBin {
  lo: number
  hi: number
  count: number
  sign: 'win' | 'loss'
}

export interface RetHistogramResult {
  runId: string
  sampleCount: number
  binWidth: number | null
  bins: RetHistogramBin[]
}

export type SignalTestWithLatestRun = SignalTest & { latestRun: SignalTestRun | null }

export interface SignalTestTrade {
  id: string
  runId: string
  tsCode: string
  name: string | null   // 标的名称（后端响应注入，可能为 null）
  signalDate: string
  buyDate: string
  exitDate: string
  buyPrice: string
  exitPrice: string
  ret: string
  holdDays: number
  exitReason:
    | 'max_hold'
    | 'signal'
    | 'delist'
    | 'stop'
    | 'ma5_exit'
    | 'phase_lock_stop'
    | 'phase_lock_ma5'
}

export interface TradesPage {
  items: SignalTestTrade[]
  total: number
}

export interface ListTradesParams {
  page?: number
  pageSize?: number
  sortField?: 'tsCode' | 'signalDate' | 'buyDate' | 'exitDate' | 'buyPrice' | 'exitPrice' | 'ret' | 'holdDays' | 'exitReason'
  sortOrder?: 'asc' | 'desc'
  tsCode?: string
  exitReason?: SignalTestTrade['exitReason']
  retMin?: number
  retMax?: number
  holdDaysMin?: number
  holdDaysMax?: number
}

export const signalStatsApi = {
  create(data: CreateSignalTestDto) {
    return post<SignalTest>(`${API_BASE}/signal-tests`, data)
  },

  findAll() {
    return request<SignalTestWithLatestRun[]>(`${API_BASE}/signal-tests`)
  },

  findOne(id: string) {
    return request<SignalTest>(`${API_BASE}/signal-tests/${id}`)
  },

  update(id: string, data: UpdateSignalTestDto) {
    return put<SignalTest>(`${API_BASE}/signal-tests/${id}`, data)
  },

  remove(id: string) {
    return del<void>(`${API_BASE}/signal-tests/${id}`)
  },

  triggerRun(id: string) {
    return post<{ runId: string }>(`${API_BASE}/signal-tests/${id}/run`)
  },

  getRunProgress(id: string) {
    // Backend returns the full run entity (incl. id/createdAt) from this endpoint.
    return request<SignalTestRun>(`${API_BASE}/signal-tests/${id}/run/progress`)
  },

  listRuns(id: string) {
    return request<SignalTestRun[]>(`${API_BASE}/signal-tests/${id}/runs`)
  },

  listTrades(runId: string, params: ListTradesParams = {}) {
    const qs = new URLSearchParams()
    qs.set('page', String(params.page ?? 1))
    qs.set('pageSize', String(params.pageSize ?? 50))
    if (params.sortField) {
      qs.set('sortField', params.sortField)
      qs.set('sortOrder', params.sortOrder ?? 'asc')
    }
    if (params.tsCode) qs.set('tsCode', params.tsCode)
    if (params.exitReason) qs.set('exitReason', params.exitReason)
    if (params.retMin != null) qs.set('retMin', String(params.retMin))
    if (params.retMax != null) qs.set('retMax', String(params.retMax))
    if (params.holdDaysMin != null) qs.set('holdDaysMin', String(params.holdDaysMin))
    if (params.holdDaysMax != null) qs.set('holdDaysMax', String(params.holdDaysMax))
    return request<TradesPage>(`${API_BASE}/signal-tests/runs/${runId}/trades?${qs.toString()}`)
  },

  getRetHistogram(runId: string, bins = 25) {
    return request<RetHistogramResult>(
      `${API_BASE}/signal-tests/runs/${runId}/ret-histogram?bins=${bins}`,
    )
  },

  /** GET /signal-tests/:id/runs/:runId/equity 迷你回测逐日净值曲线（trade_date 升序）。 */
  getEquity(testId: string, runId: string) {
    return request<SignalTestEquityRow[]>(
      `${API_BASE}/signal-tests/${testId}/runs/${runId}/equity`,
    )
  },
}
