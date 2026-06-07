import { API_BASE, post, put, del, request } from '../../client'
import type { StrategyConditionItem } from './strategyConditions'

export interface SignalTestUniverse {
  type: 'all' | 'list'
  tsCodes?: string[]
}

export interface SignalTest {
  id: string
  name: string
  buyConditions: StrategyConditionItem[]
  exitMode: 'fixed_n' | 'strategy'
  horizonN: number | null
  exitConditions: StrategyConditionItem[] | null
  maxHold: number | null
  universe: SignalTestUniverse
  dateStart: string
  dateEnd: string
  createdAt: string
  updatedAt: string
}

export interface CreateSignalTestDto {
  name: string
  buyConditions: StrategyConditionItem[]
  exitMode: 'fixed_n' | 'strategy'
  horizonN?: number
  exitConditions?: StrategyConditionItem[]
  maxHold?: number
  universe: SignalTestUniverse
  dateStart: string
  dateEnd: string
}

export type UpdateSignalTestDto = Partial<CreateSignalTestDto>

export interface SignalTestRun {
  id: string
  testId: string
  status: 'running' | 'completed' | 'failed'
  progressScanned: number
  progressTotal: number
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
  filteredCount: number
  createdAt: string
  completedAt: string | null
}

export interface SignalTestRunProgress {
  id: string
  status: 'running' | 'completed' | 'failed'
  progressScanned: number
  progressTotal: number
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
  filteredCount: number
}

export interface SignalTestTrade {
  id: string
  runId: string
  tsCode: string
  signalDate: string
  buyDate: string
  exitDate: string
  buyPrice: string
  exitPrice: string
  ret: string
  holdDays: number
  exitReason: 'max_hold' | 'signal' | 'delist'
}

export interface TradesPage {
  items: SignalTestTrade[]
  total: number
}

export const signalStatsApi = {
  create(data: CreateSignalTestDto) {
    return post<SignalTest>(`${API_BASE}/signal-tests`, data)
  },

  findAll() {
    return request<SignalTest[]>(`${API_BASE}/signal-tests`)
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
    return request<SignalTestRunProgress>(`${API_BASE}/signal-tests/${id}/run/progress`)
  },

  listRuns(id: string) {
    return request<SignalTestRun[]>(`${API_BASE}/signal-tests/${id}/runs`)
  },

  listTrades(runId: string, page = 1, pageSize = 50) {
    return request<TradesPage>(
      `${API_BASE}/signal-tests/runs/${runId}/trades?page=${page}&pageSize=${pageSize}`,
    )
  },
}
