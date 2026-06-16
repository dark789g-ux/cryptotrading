/**
 * oneClickSync store 单测（任务 B / spec §7.1、§8.2）。
 *
 * 覆盖：startRun 调 POST 并启轮询、轮询 2s patch currentRun、终态自动停轮询、
 * resumeAllPolling 仅在 running 时启、fetchActive 恢复、cancelRun 透传、
 * elapsedMs 由 startedAt(UTC 墙钟串) 派生。
 *
 * 时间串带尾 Z（'YYYY-MM-DD HH:mm:ssZ'），与后端 formatUtcWallClock 真实输出一致——
 * 作为双-Z 解析 bug 的回归守卫（旧解析器对带 Z 串再补 Z → ZZ → Invalid Date → elapsedMs=0）。
 *
 * mock api client（../api/modules/market/one-click-sync），用 vi.useFakeTimers 驱动 2s 轮询。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const { startRunMock, getActiveMock, getRunMock, cancelRunMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  getActiveMock: vi.fn(),
  getRunMock: vi.fn(),
  cancelRunMock: vi.fn(),
}))

vi.mock('../../api/modules/market/one-click-sync', () => ({
  oneClickSyncApi: {
    startRun: startRunMock,
    getActive: getActiveMock,
    getRun: getRunMock,
    cancelRun: cancelRunMock,
  },
}))

import { useOneClickSyncStore } from '../oneClickSync'
import type { OneClickSyncRun } from '../../api/modules/market/one-click-sync'

function makeRun(over: Partial<OneClickSyncRun> = {}): OneClickSyncRun {
  return {
    id: 'run-1',
    status: 'running',
    startDate: '20260601',
    endDate: '20260605',
    progress: 0,
    currentStep: 0,
    steps: [],
    logs: [],
    errorText: null,
    cancelRequested: false,
    createdBy: 'u1',
    startedAt: '2026-06-16 03:00:00Z',
    updatedAt: '2026-06-16 03:00:00Z',
    finishedAt: null,
    ...over,
  }
}

describe('oneClickSync store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    startRunMock.mockReset()
    getActiveMock.mockReset()
    getRunMock.mockReset()
    cancelRunMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('startRun 调 POST /runs，set currentRun 并启轮询', async () => {
    const created = makeRun({ progress: 5 })
    startRunMock.mockResolvedValue(created)
    const store = useOneClickSyncStore()

    const res = await store.startRun({ startDate: '20260601', endDate: '20260605' })

    expect(startRunMock).toHaveBeenCalledWith({ startDate: '20260601', endDate: '20260605' })
    expect(res).toEqual(created)
    expect(store.currentRun?.id).toBe('run-1')
    expect(store.running).toBe(true)

    // 2s 后轮询拉一次进度并 patch
    getRunMock.mockResolvedValue(makeRun({ progress: 40, currentStep: 2 }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunMock).toHaveBeenCalledWith('run-1')
    expect(store.currentRun?.progress).toBe(40)
    expect(store.totalPercent).toBe(40)
    expect(store.currentStepIndex).toBe(2)

    store.stopPolling()
  })

  it('轮询读到终态(success)自动停轮询', async () => {
    startRunMock.mockResolvedValue(makeRun())
    const store = useOneClickSyncStore()
    await store.startRun({ startDate: '20260601', endDate: '20260605' })

    getRunMock.mockResolvedValue(
      makeRun({ status: 'success', progress: 100, currentStep: null, finishedAt: '2026-06-16 03:05:00Z' }),
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.running).toBe(false)
    expect(store.currentRun?.status).toBe('success')

    // 已停轮询：再推进时间不应再调 getRun
    const callsAfterTerminal = getRunMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(getRunMock.mock.calls.length).toBe(callsAfterTerminal)
  })

  it('resumeAllPolling 仅在 running 时启轮询', async () => {
    const store = useOneClickSyncStore()

    // currentRun=null → noop
    store.resumeAllPolling()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunMock).not.toHaveBeenCalled()

    // 终态 run → 仍不启
    getActiveMock.mockResolvedValue(makeRun({ status: 'failed', currentStep: null }))
    await store.fetchActive()
    store.resumeAllPolling()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunMock).not.toHaveBeenCalled()

    // running run → 启轮询
    getActiveMock.mockResolvedValue(makeRun({ status: 'running' }))
    await store.fetchActive()
    store.resumeAllPolling()
    getRunMock.mockResolvedValue(makeRun({ progress: 12 }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunMock).toHaveBeenCalledWith('run-1')

    store.stopPolling()
  })

  it('fetchActive set currentRun（含 null）', async () => {
    const store = useOneClickSyncStore()

    getActiveMock.mockResolvedValue(null)
    const empty = await store.fetchActive()
    expect(empty).toBeNull()
    expect(store.currentRun).toBeNull()
    expect(store.running).toBe(false)

    getActiveMock.mockResolvedValue(makeRun({ progress: 30 }))
    await store.fetchActive()
    expect(store.currentRun?.progress).toBe(30)
  })

  it('cancelRun 调 POST /:id/cancel 并 patch currentRun', async () => {
    startRunMock.mockResolvedValue(makeRun())
    const store = useOneClickSyncStore()
    await store.startRun({ startDate: '20260601', endDate: '20260605' })

    cancelRunMock.mockResolvedValue(makeRun({ cancelRequested: true, status: 'running' }))
    await store.cancelRun()
    expect(cancelRunMock).toHaveBeenCalledWith('run-1')
    expect(store.currentRun?.cancelRequested).toBe(true)

    store.stopPolling()
  })

  it('cancelRun 在 currentRun=null 时 noop（不报错、不调 API）', async () => {
    const store = useOneClickSyncStore()
    await store.cancelRun()
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('elapsedMs 由 startedAt(UTC 墙钟串) 派生；终态停在 finishedAt', async () => {
    const store = useOneClickSyncStore()
    // 终态 run：startedAt 03:00:00 → finishedAt 03:02:30 = 150_000ms
    getActiveMock.mockResolvedValue(
      makeRun({
        status: 'success',
        currentStep: null,
        startedAt: '2026-06-16 03:00:00Z',
        finishedAt: '2026-06-16 03:02:30Z',
      }),
    )
    await store.fetchActive()
    expect(store.elapsedMs).toBe(150_000)
  })

  it('单飞：startRun 抛错时透传原始 message', async () => {
    startRunMock.mockRejectedValue(new Error('startDate 必须为 8 位 YYYYMMDD'))
    const store = useOneClickSyncStore()
    await expect(store.startRun({ startDate: 'bad', endDate: '20260605' })).rejects.toThrow(
      'startDate 必须为 8 位 YYYYMMDD',
    )
    expect(store.currentRun).toBeNull()
  })
})
