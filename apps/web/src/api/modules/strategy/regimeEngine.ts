import { API_BASE, del, patch, post, request } from '../../client'
import type { StrategyConditionItem } from './strategyConditions'

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
  positionRatio?: number | null
  maxPositions?: number | null
}

export interface RegimeConfigMap {
  quadrants: QuadrantEntry[]
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

export interface CreateRegimeBacktestDto {
  regimeConfigId: string
  name: string
  capital: {
    initialCapital: number
    cost: RegimeBacktestCostRates
    positionRatio: number
    maxPositions: number | null
  }
  dateStart: string
  dateEnd: string
}

export interface RegimeBacktestRun {
  id: string
  name: string
  regimeConfigId: string
  configVersion: number
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

export interface RegimeBacktestTrade {
  signalDate: string
  buyDate: string | null
  exitDate: string | null
  tsCode: string
  regime: string
  exitMode: string | null
  status: 'taken' | 'skipped'
  skipReason: string | null
  ret: number | null
  alloc: number | null
  costsPaid: number | null
  realizedRetNet: number | null
}

export interface RegimeBacktestListResult {
  total: number
  items: RegimeBacktestRun[]
}

export const regimeBacktestApi = {
  create(dto: CreateRegimeBacktestDto): Promise<RegimeBacktestRun> {
    return post<RegimeBacktestRun>(`${API_BASE}/regime-engine/backtests`, dto)
  },
  run(id: string): Promise<{ runId: string }> {
    return post<{ runId: string }>(`${API_BASE}/regime-engine/backtests/${id}/run`)
  },
  getProgress(id: string): Promise<RegimeBacktestProgress> {
    return request<RegimeBacktestProgress>(`${API_BASE}/regime-engine/backtests/${id}/progress`)
  },
  get(id: string): Promise<RegimeBacktestRun> {
    return request<RegimeBacktestRun>(`${API_BASE}/regime-engine/backtests/${id}`)
  },
  listDaily(id: string): Promise<RegimeBacktestDaily[]> {
    return request<RegimeBacktestDaily[]>(`${API_BASE}/regime-engine/backtests/${id}/daily`)
  },
  listTrades(id: string): Promise<RegimeBacktestTrade[]> {
    return request<RegimeBacktestTrade[]>(`${API_BASE}/regime-engine/backtests/${id}/trades`)
  },
  remove(id: string): Promise<void> {
    return del<void>(`${API_BASE}/regime-engine/backtests/${id}`)
  },
  list(page = 1, pageSize = 20): Promise<RegimeBacktestListResult> {
    return request<RegimeBacktestListResult>(
      `${API_BASE}/regime-engine/backtests?page=${page}&pageSize=${pageSize}`,
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
