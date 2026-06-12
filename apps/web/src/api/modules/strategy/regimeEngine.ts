import { API_BASE, patch, post, request } from '../../client'

// ── 共享类型 ──────────────────────────────────────────────────────────────────

export type RegimeKey = 'Q1' | 'Q2' | 'Q3' | 'Q4'
export type RegimeResult = RegimeKey | 'unknown'
export type RegimePickAction = 'trade' | 'flat' | 'unknown'

export interface RegimeConfigEntry {
  action: 'trade' | 'flat'
  label?: string | null
  entryConditions?: unknown[] | null
  exitMode?: string | null
  exitParams?: Record<string, unknown> | null
  [key: string]: unknown
}

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
  oamv: {
    close: number
    amvDif: number | null
    amvDea: number | null
    amvMacd: number | null
  } | null
  activeConfig: {
    id: string
    version: number
    note: string | null
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
  config: Record<RegimeKey, RegimeConfigEntry>
}

export interface CreateRegimeConfigDto {
  version?: number
  note?: string | null
  config: Record<RegimeKey, RegimeConfigEntry>
}

export interface UpdateRegimeConfigDto {
  version?: number
  note?: string | null
  config?: Record<RegimeKey, RegimeConfigEntry>
}

// ── /run-daily ────────────────────────────────────────────────────────────────

export interface RunDailyResult {
  tradeDate: string
  regime: RegimeResult
  action: RegimePickAction
  configVersion: number | null
  pickCount: number
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
