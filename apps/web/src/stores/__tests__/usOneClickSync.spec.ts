/**
 * usOneClickSync store 单测（spec 07-testing §前端1）。
 *
 * 覆盖：startRun → POST /one-click-sync + getJob → 启轮询；轮询 2s patch currentJob；终态自动停轮询；
 * resumePolling 仅 running 启；fetchActive 取 listJobs items[0]；cancelRun 调 cancelJob；
 * resultPayload（含 3 步 + logs）→ steps/totalPercent/logs/summary getter 映射；
 * resultPayload={}/缺失 → 兜底 3 步 pending；elapsedMs 由 payload.startedAt(epoch ms) 派生。
 *
 * mock：startUsOneClickSync（../api/modules/market/usStocks）+ quantApi（../api/modules/quant）；
 * 用 vi.useFakeTimers 驱动 2s 轮询。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const { startUsOneClickSyncMock, getJobMock, listJobsMock, cancelJobMock } = vi.hoisted(() => ({
  startUsOneClickSyncMock: vi.fn(),
  getJobMock: vi.fn(),
  listJobsMock: vi.fn(),
  cancelJobMock: vi.fn(),
}))

vi.mock('../../api/modules/market/usStocks', () => ({
  startUsOneClickSync: startUsOneClickSyncMock,
}))

vi.mock('../../api/modules/quant', () => ({
  quantApi: {
    getJob: getJobMock,
    listJobs: listJobsMock,
    cancelJob: cancelJobMock,
  },
}))

import { useUsOneClickSyncStore } from '../usOneClickSync'
import type { JobRow } from '../../api/modules/quant'
import {
  US_STEP_LABELS,
  buildInitialUsSteps,
  type OneClickStepState,
} from '../../components/sync/oneClickSync.types'

const T0 = 1_718_600_000_000 // payload.startedAt 基准

function step(over: Partial<OneClickStepState> & { step: string }): OneClickStepState {
  return {
    label: '', // 后端不下发 label（schema 无此字段），store 应补全
    status: 'pending',
    percent: 0,
    phase: '',
    message: '',
    rowsWritten: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
    ...over,
  } as OneClickStepState
}

function makeJob(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    runType: 'us_one_click_sync',
    status: 'running',
    progress: 0,
    stage: null,
    priority: 0,
    attempts: 0,
    maxAttempts: 1,
    cancelRequested: false,
    parentJobId: null,
    params: {},
    errorText: null,
    blockedReason: null,
    createdBy: 'u1',
    createdAt: '2026-06-17 03:00:00Z',
    startedAt: '2026-06-17 03:00:00Z',
    finishedAt: null,
    heartbeatAt: null,
    resultPayload: {},
    ...over,
  }
}

/** 含 3 步 + logs 的完整 result_payload。 */
function fullPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    range: { start: '20260601', end: '20260605' },
    startedAt: T0,
    finishedAt: null,
    cancelled: false,
    steps: [
      step({ step: 'us-stocks', status: 'success', percent: 100, rowsWritten: 36806 }),
      step({ step: 'us-index-daily', status: 'running', percent: 50, rowsWritten: 3099 }),
      step({ step: 'us-index-amv', status: 'pending' }),
    ],
    logs: [
      { ts: T0, step: 'us-stocks', level: 'info', text: '开始美股个股同步' },
      { ts: T0 + 1000, step: 'us-index-daily', level: 'info', text: '美股指数日线' },
    ],
    ...over,
  }
}

describe('usOneClickSync store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    startUsOneClickSyncMock.mockReset()
    getJobMock.mockReset()
    listJobsMock.mockReset()
    cancelJobMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('startRun 调 POST /one-click-sync + getJob，set currentJob 并启轮询', async () => {
    startUsOneClickSyncMock.mockResolvedValue({ jobId: 'job-1' })
    getJobMock.mockResolvedValueOnce(makeJob({ progress: 5 }))
    const store = useUsOneClickSyncStore()

    const res = await store.startRun({ startDate: '20260601', endDate: '20260605' })

    expect(startUsOneClickSyncMock).toHaveBeenCalledWith({ dateRange: ['20260601', '20260605'] })
    expect(getJobMock).toHaveBeenCalledWith('job-1')
    expect(res.id).toBe('job-1')
    expect(store.currentJob?.id).toBe('job-1')
    expect(store.running).toBe(true)

    // 2s 后轮询拉一次进度并 patch
    getJobMock.mockResolvedValueOnce(
      makeJob({ progress: 40, resultPayload: fullPayload() }),
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(getJobMock).toHaveBeenLastCalledWith('job-1')
    expect(store.totalPercent).toBe(40)

    store.stopPolling()
  })

  it('steps/totalPercent/logs 由 resultPayload 映射，且 step 补 US_STEP_LABELS', async () => {
    listJobsMock.mockResolvedValue({
      rows: [makeJob({ progress: 60, resultPayload: fullPayload() })],
      total: 1, page: 1, pageSize: 1,
    })
    const store = useUsOneClickSyncStore()
    await store.fetchActive()

    expect(store.steps.map(s => s.step)).toEqual(['us-stocks', 'us-index-daily', 'us-index-amv'])
    expect(store.steps.map(s => s.label)).toEqual([
      US_STEP_LABELS['us-stocks'],
      US_STEP_LABELS['us-index-daily'],
      US_STEP_LABELS['us-index-amv'],
    ])
    expect(store.steps[0].rowsWritten).toBe(36806)
    expect(store.totalPercent).toBe(60)
    expect(store.logs).toHaveLength(2)
    expect(store.logs[0].text).toBe('开始美股个股同步')
    // running 中 currentStepIndex 指向唯一 running 步（idx 1）
    expect(store.currentStepIndex).toBe(1)
  })

  it('resultPayload={} → 兜底 3 步 pending', async () => {
    listJobsMock.mockResolvedValue({
      rows: [makeJob({ resultPayload: {} })],
      total: 1, page: 1, pageSize: 1,
    })
    const store = useUsOneClickSyncStore()
    await store.fetchActive()

    const fallback = buildInitialUsSteps()
    expect(store.steps).toHaveLength(3)
    expect(store.steps.map(s => s.status)).toEqual(['pending', 'pending', 'pending'])
    expect(store.steps.map(s => s.step)).toEqual(fallback.map(s => s.step))
    expect(store.steps.map(s => s.label)).toEqual(fallback.map(s => s.label))
    expect(store.logs).toEqual([])
  })

  it('resultPayload 缺失（undefined）同样兜底 3 步 pending', async () => {
    listJobsMock.mockResolvedValue({
      rows: [makeJob({ resultPayload: undefined })],
      total: 1, page: 1, pageSize: 1,
    })
    const store = useUsOneClickSyncStore()
    await store.fetchActive()
    expect(store.steps).toHaveLength(3)
    expect(store.steps.every(s => s.status === 'pending')).toBe(true)
  })

  it('summary：终态(success)由 resultPayload 派生（步骤带 label + 聚合 errors）', async () => {
    const payload = fullPayload({
      finishedAt: T0 + 150_000,
      steps: [
        step({ step: 'us-stocks', status: 'success', percent: 100, rowsWritten: 36806 }),
        step({
          step: 'us-index-daily', status: 'failed', percent: 0,
          errors: [{ step: 'us-index-daily', level: 'error', apiName: 'us_daily_empty', message: '空' }],
        }),
        step({ step: 'us-index-amv', status: 'success', percent: 100, rowsWritten: 113 }),
      ],
    })
    listJobsMock.mockResolvedValue({
      rows: [makeJob({ status: 'failed', progress: 100, resultPayload: payload })],
      total: 1, page: 1, pageSize: 1,
    })
    const store = useUsOneClickSyncStore()
    await store.fetchActive()

    const sum = store.summary
    expect(sum).not.toBeNull()
    expect(sum?.steps).toHaveLength(3)
    expect(sum?.steps[1].label).toBe(US_STEP_LABELS['us-index-daily'])
    expect(sum?.errors).toHaveLength(1)
    expect(sum?.errors[0].apiName).toBe('us_daily_empty')
    expect(sum?.cancelled).toBe(false)
    // 终态：elapsedMs = finishedAt - startedAt
    expect(store.elapsedMs).toBe(150_000)
  })

  it('summary：running 时为 null', async () => {
    listJobsMock.mockResolvedValue({
      rows: [makeJob({ status: 'running', resultPayload: fullPayload() })],
      total: 1, page: 1, pageSize: 1,
    })
    const store = useUsOneClickSyncStore()
    await store.fetchActive()
    expect(store.summary).toBeNull()
  })

  it('summary.cancelled：job 终态 cancelled 时为 true', async () => {
    listJobsMock.mockResolvedValue({
      rows: [makeJob({ status: 'cancelled', resultPayload: fullPayload({ cancelled: true, finishedAt: T0 + 1000 }) })],
      total: 1, page: 1, pageSize: 1,
    })
    const store = useUsOneClickSyncStore()
    await store.fetchActive()
    expect(store.summary?.cancelled).toBe(true)
  })

  it('轮询读到终态(success)自动停轮询', async () => {
    startUsOneClickSyncMock.mockResolvedValue({ jobId: 'job-1' })
    getJobMock.mockResolvedValueOnce(makeJob())
    const store = useUsOneClickSyncStore()
    await store.startRun({ startDate: '20260601', endDate: '20260605' })

    getJobMock.mockResolvedValue(
      makeJob({ status: 'success', progress: 100, resultPayload: fullPayload({ finishedAt: T0 + 1000 }) }),
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.running).toBe(false)
    expect(store.currentJob?.status).toBe('success')

    // 已停轮询：再推进时间不应再调 getJob
    const callsAfter = getJobMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(getJobMock.mock.calls.length).toBe(callsAfter)
  })

  it('resumePolling 仅在 running 时启轮询', async () => {
    const store = useUsOneClickSyncStore()

    // currentJob=null → noop
    store.resumePolling()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getJobMock).not.toHaveBeenCalled()

    // 终态 job → 仍不启
    listJobsMock.mockResolvedValue({ rows: [makeJob({ status: 'failed' })], total: 1, page: 1, pageSize: 1 })
    await store.fetchActive()
    store.resumePolling()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getJobMock).not.toHaveBeenCalled()

    // running job → 启轮询
    listJobsMock.mockResolvedValue({ rows: [makeJob({ status: 'running' })], total: 1, page: 1, pageSize: 1 })
    await store.fetchActive()
    store.resumePolling()
    getJobMock.mockResolvedValue(makeJob({ progress: 12 }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(getJobMock).toHaveBeenCalledWith('job-1')

    store.stopPolling()
  })

  it('fetchActive 取 listJobs items[0]（含空列表 → null）', async () => {
    const store = useUsOneClickSyncStore()

    listJobsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1 })
    const empty = await store.fetchActive()
    expect(listJobsMock).toHaveBeenCalledWith({ run_type: ['us_one_click_sync'], page: 1, pageSize: 1 })
    expect(empty).toBeNull()
    expect(store.currentJob).toBeNull()
    expect(store.running).toBe(false)

    listJobsMock.mockResolvedValue({ rows: [makeJob({ progress: 30 })], total: 1, page: 1, pageSize: 1 })
    await store.fetchActive()
    expect(store.currentJob?.progress).toBe(30)
  })

  it('cancelRun 调 cancelJob(:id)；currentJob=null 时 noop', async () => {
    const store = useUsOneClickSyncStore()
    // null → noop
    await store.cancelRun()
    expect(cancelJobMock).not.toHaveBeenCalled()

    startUsOneClickSyncMock.mockResolvedValue({ jobId: 'job-1' })
    getJobMock.mockResolvedValueOnce(makeJob())
    await store.startRun({ startDate: '20260601', endDate: '20260605' })

    cancelJobMock.mockResolvedValue({ ok: true })
    await store.cancelRun()
    expect(cancelJobMock).toHaveBeenCalledWith('job-1')

    store.stopPolling()
  })

  it('startRun 抛错时透传原始 message，currentJob 保持 null', async () => {
    startUsOneClickSyncMock.mockRejectedValue(new Error('dateRange 必须为 8 位 YYYYMMDD'))
    const store = useUsOneClickSyncStore()
    await expect(
      store.startRun({ startDate: 'bad', endDate: '20260605' }),
    ).rejects.toThrow('dateRange 必须为 8 位 YYYYMMDD')
    expect(store.currentJob).toBeNull()
  })
})
