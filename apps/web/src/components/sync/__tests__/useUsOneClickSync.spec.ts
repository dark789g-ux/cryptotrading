/**
 * useUsOneClickSync 控制器单测（spec 07-testing §前端2）。
 *
 * 覆盖：canStart 随 dateRange 两端齐全翻真；start() 经 toYYYYMMDD（本地 TZ，非 UTC）提交、
 * dateRange=null 时 message.error 不调 store；getter 透传 store（含 store 已补的 step label）。
 *
 * mock store.startRun 用 spy 验证提交的 YYYYMMDD；setActivePinia 给真实 store。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUsOneClickSync } from '../useUsOneClickSync'
import { US_STEP_LABELS, type OneClickStepState } from '../oneClickSync.types'
import { useUsOneClickSyncStore } from '../../../stores/usOneClickSync'
import { formatUTCDateTime } from '../../symbols/a-shares/aSharesFormatters'
import type { JobRow } from '../../../api/modules/quant'

vi.mock('@/api/modules/user-config/preferences', () => ({
  preferencesApi: {
    getSyncSteps: vi.fn().mockResolvedValue({ steps: [] }),
    saveSyncSteps: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

import { preferencesApi } from '@/api/modules/user-config/preferences'

function makeMessage() {
  return { error: vi.fn(), success: vi.fn() }
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
    createdBy: null,
    createdAt: '2026-06-17 03:00:00Z',
    startedAt: '2026-06-17 03:00:00Z',
    finishedAt: null,
    heartbeatAt: null,
    resultPayload: {},
    ...over,
  }
}

describe('useUsOneClickSync 控制器', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('canStart：dateRange 两端齐全（且非 running）时为 true', () => {
    const ctrl = useUsOneClickSync(makeMessage())
    expect(ctrl.canStart.value).toBe(false) // 初始 dateRange=null

    ctrl.dateRange.value = [Date.now(), 0] // 缺右端
    expect(ctrl.canStart.value).toBe(false)

    ctrl.dateRange.value = [new Date(2026, 5, 1).getTime(), new Date(2026, 5, 5).getTime()]
    expect(ctrl.canStart.value).toBe(true)
  })

  it('canStart：running 时即使日期齐全也为 false', () => {
    const store = useUsOneClickSyncStore()
    store.currentJob = makeJob({ status: 'running' })
    const ctrl = useUsOneClickSync(makeMessage())
    ctrl.dateRange.value = [new Date(2026, 5, 1).getTime(), new Date(2026, 5, 5).getTime()]
    expect(ctrl.canStart.value).toBe(false)
  })

  it('start()：本地午夜 ms 经 toYYYYMMDD（本地 TZ）转 YYYYMMDD 调 store.startRun', async () => {
    const store = useUsOneClickSyncStore()
    const startSpy = vi.spyOn(store, 'startRun').mockResolvedValue(makeJob())
    const ctrl = useUsOneClickSync(makeMessage())

    // 本地午夜（new Date(y,m,d) → 本地 TZ）；用本地 getFullYear/Month/Date 提取应得 2026-06-01 / 06-05
    ctrl.dateRange.value = [new Date(2026, 5, 1).getTime(), new Date(2026, 5, 5).getTime()]
    await ctrl.start()

    expect(startSpy).toHaveBeenCalledWith({ startDate: '20260601', endDate: '20260605' })
  })

  it('start()：dateRange=null → message.error，不调 store.startRun', async () => {
    const store = useUsOneClickSyncStore()
    const startSpy = vi.spyOn(store, 'startRun')
    const message = makeMessage()
    const ctrl = useUsOneClickSync(message)

    await ctrl.start()
    expect(message.error).toHaveBeenCalledWith('请先选择日期范围')
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('start()：store.startRun 抛错时 message.error 透传原文', async () => {
    const store = useUsOneClickSyncStore()
    vi.spyOn(store, 'startRun').mockRejectedValue(new Error('dateRange 非法'))
    const message = makeMessage()
    const ctrl = useUsOneClickSync(message)
    ctrl.dateRange.value = [new Date(2026, 5, 1).getTime(), new Date(2026, 5, 5).getTime()]
    await ctrl.start()
    expect(message.error).toHaveBeenCalledWith('dateRange 非法')
  })

  it('cancel()：调 store.cancelRun', async () => {
    const store = useUsOneClickSyncStore()
    const cancelSpy = vi.spyOn(store, 'cancelRun').mockResolvedValue(undefined)
    const ctrl = useUsOneClickSync(makeMessage())
    await ctrl.cancel()
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('getter 透传 store（steps 已带 store 补的 US_STEP_LABELS label）', () => {
    const store = useUsOneClickSyncStore()
    const backendStep: OneClickStepState = {
      step: 'us-stocks', label: '', status: 'running', percent: 50,
      phase: '', message: '', rowsWritten: 100, errors: [], startedAt: null, finishedAt: null,
    }
    store.currentJob = makeJob({
      progress: 50,
      resultPayload: {
        startedAt: 1, steps: [backendStep],
        logs: [{ ts: 1, step: 'us-stocks', level: 'info', text: 'hi' }],
      },
    })
    const ctrl = useUsOneClickSync(makeMessage())
    expect(ctrl.running.value).toBe(true)
    expect(ctrl.totalPercent.value).toBe(50)
    expect(ctrl.steps.value[0].label).toBe(US_STEP_LABELS['us-stocks'])
    expect(ctrl.logEntries.value).toHaveLength(1)
  })

  it('latestSyncText：store.latestSuccessJob 有 finishedAt 时格式化输出', () => {
    const store = useUsOneClickSyncStore()
    const finishedAt = '2026-06-29 10:15:30Z'
    store.latestSuccessJob = makeJob({ status: 'success', finishedAt })
    const ctrl = useUsOneClickSync(makeMessage())
    expect(ctrl.latestSyncText.value).toBe(formatUTCDateTime(finishedAt))
  })

  it('latestSyncText：store.latestSuccessJob 为 null 时返回空串', () => {
    const store = useUsOneClickSyncStore()
    store.latestSuccessJob = null
    const ctrl = useUsOneClickSync(makeMessage())
    expect(ctrl.latestSyncText.value).toBe('')
  })

  it('创建时触发 loadPreference(us)', async () => {
    useUsOneClickSync(makeMessage())
    await vi.waitFor(() => {
      expect(preferencesApi.getSyncSteps).toHaveBeenCalledWith('us')
    })
  })

  it('start() 成功后触发 savePreference(us)', async () => {
    const store = useUsOneClickSyncStore()
    vi.spyOn(store, 'startRun').mockResolvedValue(makeJob())
    const ctrl = useUsOneClickSync(makeMessage())
    ctrl.dateRange.value = [new Date(2026, 5, 1).getTime(), new Date(2026, 5, 5).getTime()]

    await ctrl.start()

    await vi.waitFor(() => {
      expect(preferencesApi.saveSyncSteps).toHaveBeenCalledWith('us', expect.any(Object))
    })
  })

  it('start() 失败时不触发 savePreference', async () => {
    const store = useUsOneClickSyncStore()
    vi.spyOn(store, 'startRun').mockRejectedValue(new Error('fail'))
    const ctrl = useUsOneClickSync(makeMessage())
    ctrl.dateRange.value = [new Date(2026, 5, 1).getTime(), new Date(2026, 5, 5).getTime()]

    await ctrl.start()

    expect(preferencesApi.saveSyncSteps).not.toHaveBeenCalled()
  })
})
