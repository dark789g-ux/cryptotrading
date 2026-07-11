import { API_BASE, del, patch, post, request } from '../../client'
import type { StrategyConditionItem } from './strategyConditions'
import type { KlineChartBar } from '../market/symbols'

// ── 共享类型 ──────────────────────────────────────────────────────────────────

export type RegimeKey = string
export type RegimeResult = RegimeKey | 'unknown'
export type RegimePickAction = 'trade' | 'flat' | 'unknown'

export interface RegimeBucketCondition {
  type: 'index' | 'stock'
  target: string
  field: string
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below'
  value?: number
  compareField?: string
  compareMode?: 'value' | 'field'
}

export interface QuadrantEntry {
  key: string
  label: string
  match: RegimeBucketCondition[]
  action: 'trade' | 'flat'
  entryConditions?: StrategyConditionItem[] | null
  exitMode?: string | null
  exitParams?: Record<string, unknown> | null
  /** trade 必填 (0,1]；flat 可为 null */
  positionRatio?: number | null
  /** trade 必填正整数；flat 可为 null */
  maxPositions?: number | null
  /** trade 必填；短名单字段或 none */
  rankField?: string | null
  /** rankField≠none 时必填；none 时为 null */
  rankDir?: 'asc' | 'desc' | null
  /** trade 可选：仅当全部现存持仓盈利时才开新仓；缺省 false */
  requireAllPositionsProfitable?: boolean
}

export interface RegimeUniverse {
  mode: 'all' | 'watchlist' | 'symbols'
  watchlistId?: string
  symbols?: string[]
}

export interface RegimeConfigMap {
  quadrants: QuadrantEntry[]
  universe?: RegimeUniverse
}

export type RegimeConfigEntry = QuadrantEntry

// ── /today ────────────────────────────────────────────────────────────────────

export interface RegimeDailyPick {
  id: string
  tradeDate: string
  regime: RegimeResult
  configVersion: number | null
  action: RegimePickAction
  tsCode: string | null
  name: string | null
  snapshot: Record<string, unknown> | null
  createdAt: string
}

export interface RegimeTodaySummary {
  tradeDate: string | null
  regime: RegimeResult
  activeConfig: {
    id: string
    version: number
    note: string | null
    entryIndex: number | null
    entry: RegimeConfigEntry | null
  } | null
  picks: RegimeDailyPick[]
}

// ── /configs ──────────────────────────────────────────────────────────────────

export interface RegimeStrategyConfig {
  id: string
  version: number
  status: 'draft' | 'active' | 'archived'
  note: string | null
  createdAt: string
  config: RegimeConfigMap
}

export interface CreateRegimeConfigDto {
  version?: number
  note?: string | null
  config: RegimeConfigMap
}

export interface UpdateRegimeConfigDto {
  version?: number
  note?: string | null
  config?: RegimeConfigMap
}

// ── /run-daily ────────────────────────────────────────────────────────────────

export interface RunDailyResult {
  tradeDate: string
  regime: RegimeResult
  action: RegimePickAction
  configVersion: number | null
  pickCount: number
}

// ── /backtests ────────────────────────────────────────────────────────────────

export interface RegimeBacktestCostRates {
  commissionPerSide: number
  transferPerSide: number
  stampSellBefore20230828: number
  stampSellFrom20230828: number
  slippagePerSide: number
}

export interface RegimeSizingConfig {
  mode: 'fixed' | 'signal_weighted' | 'source_kelly'
  floorMult: number
  capMult: number
  kellyFraction: number
  kellyMaxMult: number
}

export interface RegimeKellyConfig {
  enabled: boolean
  simTrades: number
  windowTrades: number
  stepTrades: number
  kellyFraction: number
  kellyMaxMult: number
  enableProbe: boolean
}

export interface RegimeCircuitBreaker {
  enableCooldown: boolean
  consecutiveLossesThreshold: number
  baseCooldownDays: number
  maxCooldownDays: number
  extendOnLoss: number
  reduceOnProfit: number
  enableDrawdownHalt: boolean
  drawdownHaltPct: number
  drawdownResumePct: number
}

export interface RegimeBacktestCapital {
  initialCapital: number
  cost: RegimeBacktestCostRates
  /** @deprecated 若传入后端会忽略 */
  positionRatio?: number
  /** @deprecated 若传入后端会忽略 */
  maxPositions?: number | null
  sizing?: RegimeSizingConfig
  kelly?: RegimeKellyConfig
  circuitBreaker?: RegimeCircuitBreaker
  anchorMode?: boolean
  requireAllPositionsProfitable?: boolean
}

export interface CreateRegimeBacktestDto {
  name: string
  note?: string
  /** 必填：内联 Regime 规则 */
  config: RegimeConfigMap
  /** 可选，仅溯源；不用于加载规则 */
  regimeConfigId?: string
  capital: RegimeBacktestCapital
  dateStart: string
  dateEnd: string
}

/** PATCH：与 create 字段对齐；仅 pending/failed 可更新 */
export type UpdateRegimeBacktestDto = Pick<
  CreateRegimeBacktestDto,
  'name' | 'config' | 'capital' | 'dateStart' | 'dateEnd'
> &
  Partial<Pick<CreateRegimeBacktestDto, 'note' | 'regimeConfigId'>>

/** 回测 run.config jsonb 快照：内层 config 为象限规则，capital 为资金/成本 */
export interface RegimeBacktestConfigSnapshot {
  config: RegimeConfigMap
  capital: RegimeBacktestCapital
}

export interface RegimeBacktestRun {
  id: string
  name: string
  regimeConfigId: string | null
  /** 有 FK 的历史 run 为版本号；内联创建时为 null */
  regimeConfigVersion: number | null
  /** findOne / list 均返回实体 jsonb；列表场景可不依赖 */
  config?: RegimeBacktestConfigSnapshot
  dateStart: string
  dateEnd: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  phase: string | null
  progressDone: number | null
  progressTotal: number | null
  errorMessage: string | null
  finalNav: number | null
  totalRet: number | null
  annualRet: number | null
  maxDrawdown: number | null
  sharpe: number | null
  calmar: number | null
  nTaken: number | null
  nSkipped: number | null
  totalCosts: number | null
  createdAt: string
  completedAt: string | null
}

export interface RegimeBacktestProgress {
  status: 'pending' | 'running' | 'completed' | 'failed'
  phase: string | null
  progressDone: number | null
  progressTotal: number | null
  errorMessage: string | null
}

export interface RegimeBacktestDaily {
  tradeDate: string
  nav: number
  cash: number
  dailyRet: number
  positionCount: number
  exposure: number
}

export type RegimeTradePhase = 'simulation' | 'probe' | 'live'

export interface RegimeBacktestTrade {
  signalDate: string
  buyDate: string | null
  exitDate: string | null
  tsCode: string
  regime: string
  exitMode: string | null
  status: 'taken' | 'skipped'
  skipReason: string | null
  /** kelly 管线阶段；未启用 kelly 时为 null */
  tradePhase: RegimeTradePhase | null
  ret: number | null
  alloc: number | null
  costsPaid: number | null
  realizedRetNet: number | null
  /** 同日排序名次；1=入选；审计行 ≥2 */
  rank: number | null
  rankField: string | null
  rankValue: number | null
}

export interface RegimeBacktestListResult {
  total: number
  items: RegimeBacktestRun[]
}

export interface RegimeDailyAuditEntry {
  tsCode: string
  signalDate: string
  buyDate: string
  status: 'taken' | 'skipped'
  skipReason?: string | null
  alloc?: number | null
  tradePhase?: RegimeTradePhase | null
}

export interface RegimeDailyAuditExit {
  tsCode: string
  exitDate: string
  ret?: number | null
  realizedRetNet?: number | null
  exitReason?: string | null
  tradePhase?: RegimeTradePhase | null
}

export interface RegimeBacktestDailyLog {
  tradeDate: string
  nav: number
  cash: number
  regime: string
  frozenReason: string | null
  tradePhase: RegimeTradePhase | null
  entries: RegimeDailyAuditEntry[]
  exits: RegimeDailyAuditExit[]
  openSymbols: string[]
  cooldown: {
    inCooldown: boolean
    duration: number | null
    remaining: number | null
    consecLosses: number
  }
}

export interface RegimeBacktestPositionRow {
  tsCode: string
  signalDate: string
  buyDate: string
  exitDate: string | null
  regime: string
  exitMode: string | null
  tradePhase: RegimeTradePhase | null
  alloc: number | null
  ret: number | null
  realizedRetNet: number | null
  exitReason: string | null
  costsPaid: number | null
}

export interface RegimeBacktestSymbolStatRow {
  tsCode: string
  tradeCount: number
  winCount: number
  lossCount: number
  totalAlloc: number
  totalPnl: number
  avgRet: number | null
  avgRealizedRetNet: number | null
}

export interface RegimeRowsPage<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

export interface RegimeTradeOnBar {
  type: 'entry' | 'exit'
  tsCode: string
  price: number
  reason: string
  pnl?: number
  tradePhase?: RegimeTradePhase | null
}

export type RegimeBacktestKlineBar = KlineChartBar & {
  trades?: RegimeTradeOnBar[]
}

/** A 股 Regime 回测：主路径 /backtest/ashare（旧 /regime-engine/backtests 仍可用） */
const ASHARE_BACKTEST_BASE = `${API_BASE}/backtest/ashare`

export const regimeBacktestApi = {
  create(dto: CreateRegimeBacktestDto): Promise<RegimeBacktestRun> {
    return post<RegimeBacktestRun>(ASHARE_BACKTEST_BASE, dto)
  },
  update(id: string, dto: UpdateRegimeBacktestDto): Promise<RegimeBacktestRun> {
    return patch<RegimeBacktestRun>(`${ASHARE_BACKTEST_BASE}/${id}`, dto)
  },
  run(id: string): Promise<{ runId: string }> {
    return post<{ runId: string }>(`${ASHARE_BACKTEST_BASE}/${id}/run`)
  },
  getProgress(id: string): Promise<RegimeBacktestProgress> {
    return request<RegimeBacktestProgress>(`${ASHARE_BACKTEST_BASE}/${id}/progress`)
  },
  get(id: string): Promise<RegimeBacktestRun> {
    return request<RegimeBacktestRun>(`${ASHARE_BACKTEST_BASE}/${id}`)
  },
  listDaily(id: string): Promise<RegimeBacktestDaily[]> {
    return request<RegimeBacktestDaily[]>(`${ASHARE_BACKTEST_BASE}/${id}/daily`)
  },
  listTrades(id: string): Promise<RegimeBacktestTrade[]> {
    return request<RegimeBacktestTrade[]>(`${ASHARE_BACKTEST_BASE}/${id}/trades`)
  },
  listDailyLog(id: string): Promise<RegimeBacktestDailyLog[]> {
    return request<RegimeBacktestDailyLog[]>(`${ASHARE_BACKTEST_BASE}/${id}/daily-log`)
  },
  listPositions(
    id: string,
    params?: {
      page?: number
      pageSize?: number
      sortBy?: string
      sortOrder?: 'asc' | 'desc'
      tsCode?: string
    },
  ): Promise<RegimeRowsPage<RegimeBacktestPositionRow>> {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize))
    if (params?.sortBy) qs.set('sortBy', params.sortBy)
    if (params?.sortOrder) qs.set('sortOrder', params.sortOrder)
    if (params?.tsCode) qs.set('tsCode', params.tsCode)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<RegimeRowsPage<RegimeBacktestPositionRow>>(
      `${ASHARE_BACKTEST_BASE}/${id}/positions${suffix}`,
    )
  },
  listSymbolStats(
    id: string,
    params?: {
      page?: number
      pageSize?: number
      sortBy?: string
      sortOrder?: 'asc' | 'desc'
      tsCode?: string
    },
  ): Promise<RegimeRowsPage<RegimeBacktestSymbolStatRow>> {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize))
    if (params?.sortBy) qs.set('sortBy', params.sortBy)
    if (params?.sortOrder) qs.set('sortOrder', params.sortOrder)
    if (params?.tsCode) qs.set('tsCode', params.tsCode)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<RegimeRowsPage<RegimeBacktestSymbolStatRow>>(
      `${ASHARE_BACKTEST_BASE}/${id}/symbol-stats${suffix}`,
    )
  },
  getKlineChart(
    id: string,
    params: { tsCode: string; signalDate: string; before?: number; after?: number },
  ): Promise<RegimeBacktestKlineBar[]> {
    const qs = new URLSearchParams()
    qs.set('tsCode', params.tsCode)
    qs.set('signalDate', params.signalDate)
    if (params.before != null) qs.set('before', String(params.before))
    if (params.after != null) qs.set('after', String(params.after))
    return request<RegimeBacktestKlineBar[]>(
      `${ASHARE_BACKTEST_BASE}/${id}/kline-chart?${qs.toString()}`,
    )
  },
  remove(id: string): Promise<void> {
    return del<void>(`${ASHARE_BACKTEST_BASE}/${id}`)
  },
  list(
    page = 1,
    pageSize = 20,
    filter?: { status?: string; keyword?: string },
  ): Promise<RegimeBacktestListResult> {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    if (filter?.status) params.set('status', filter.status);
    if (filter?.keyword) params.set('keyword', filter.keyword);
    return request<RegimeBacktestListResult>(
      `${ASHARE_BACKTEST_BASE}?${params.toString()}`,
    )
  },
}

// ── API 对象 ──────────────────────────────────────────────────────────────────

export const regimeEngineApi = {
  getToday(): Promise<RegimeTodaySummary> {
    return request<RegimeTodaySummary>(`${API_BASE}/regime-engine/today`)
  },

  getPicks(tradeDate: string): Promise<RegimeDailyPick[]> {
    return request<RegimeDailyPick[]>(
      `${API_BASE}/regime-engine/picks?tradeDate=${encodeURIComponent(tradeDate)}`,
    )
  },

  listConfigs(): Promise<RegimeStrategyConfig[]> {
    return request<RegimeStrategyConfig[]>(`${API_BASE}/regime-engine/configs`)
  },

  createConfig(dto: CreateRegimeConfigDto): Promise<RegimeStrategyConfig> {
    return post<RegimeStrategyConfig>(`${API_BASE}/regime-engine/configs`, dto)
  },

  updateConfig(id: string, dto: UpdateRegimeConfigDto): Promise<RegimeStrategyConfig> {
    return patch<RegimeStrategyConfig>(`${API_BASE}/regime-engine/configs/${id}`, dto)
  },

  activateConfig(id: string): Promise<RegimeStrategyConfig> {
    return post<RegimeStrategyConfig>(`${API_BASE}/regime-engine/configs/${id}/activate`)
  },

  runDaily(tradeDate?: string): Promise<RunDailyResult> {
    return post<RunDailyResult>(`${API_BASE}/regime-engine/run-daily`, tradeDate ? { tradeDate } : {})
  },
}
