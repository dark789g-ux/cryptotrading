import { API_BASE, post, put, del, request } from '../../client'
import type { StrategyConditionItem } from './strategyConditions'

export interface SignalTestUniverse {
  type: 'all' | 'list'
  tsCodes?: string[]
}

export type SignalTestExitMode = 'fixed_n' | 'strategy' | 'trailing_lock'

export interface SignalTest {
  id: string
  name: string
  buyConditions: StrategyConditionItem[]
  exitMode: SignalTestExitMode
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
  exitMode: SignalTestExitMode
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
  bestTradeRet: string | null
  filteredCount: number
  createdAt: string
  completedAt: string | null
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
  exitReason: 'max_hold' | 'signal' | 'delist' | 'stop' | 'ma5_exit'
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
}
