import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock 工厂被提升到 import 之前，工厂内不能引用顶层局部变量；
// 用 vi.hoisted 把 mock 提升到同一阶段，规避「Cannot access before init」。
// statusRef 用真 Vue ref，computed(syncProgressVisible) 才能响应其变化。
const { startMock, resetMock, statusRef, requestMock } = vi.hoisted(() => {
  // hoisted 在 import 之前执行，此处不能 import vue；
  // 但 vitest 的 hoisted 工厂里可以 require('vue')。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ref: vueRef } = require('vue') as typeof import('vue')
  return {
    startMock: vi.fn(),
    resetMock: vi.fn(),
    statusRef: vueRef<'idle' | 'running' | 'done' | 'error'>('idle'),
    requestMock: vi.fn(),
  }
})

// useSSE mock：start 同步保存 options 供测试触发 onDone/onError；status 用可变对象。
vi.mock('@/composables/hooks/useSSE', () => ({
  useSSE: () => ({
    status: statusRef,
    percent: { value: 0 },
    phase: { value: '' },
    message: { value: '' },
    current: { value: 0 },
    total: { value: 0 },
    start: startMock,
    reset: resetMock,
  }),
}))

// request mock：openModal 调它取库存范围。
vi.mock('@/api/client', () => ({
  API_BASE: '/api',
  request: requestMock,
}))

import { useBaseDataSync } from './useBaseDataSync'

function makeMessage() {
  return { error: vi.fn(), success: vi.fn() }
}

function setStatus(v: 'idle' | 'running' | 'done' | 'error') {
  statusRef.value = v
}

describe('useBaseDataSync', () => {
  beforeEach(() => {
    startMock.mockReset()
    resetMock.mockReset()
    requestMock.mockReset()
    setStatus('idle')
  })

  it('confirmSync 的 done 事件 → finished 置位 + syncing=false', async () => {
    const message = makeMessage()
    const api = useBaseDataSync(message)

    // 给一个确定的日期范围，避免依赖默认计算
    api.syncDateRange.value = [new Date(2026, 0, 5).getTime(), new Date(2026, 0, 7).getTime()]

    // start 被调用时捕获 options，再模拟后端 done 事件
    startMock.mockImplementation(async (_url: string, options: { onDone?: (d?: unknown) => void }) => {
      options.onDone?.({ result: { success: 10, skipped: 2, errors: [] } })
    })

    await api.confirmSync()

    expect(startMock).toHaveBeenCalledTimes(1)
    const url = startMock.mock.calls[0][0] as string
    expect(url).toContain('/api/base-data/sync/run')
    expect(url).toContain('start_date=20260105')
    expect(url).toContain('end_date=20260107')
    expect(url).toContain('syncMode=incremental')

    expect(api.finished.value).toEqual({ result: { success: 10, skipped: 2, errors: [] } })
    expect(api.syncing.value).toBe(false)
  })

  it('done 事件带 warnings（空日警告）→ finished 透传 warnings，且不计入失败弹窗', async () => {
    const message = makeMessage()
    const api = useBaseDataSync(message)
    api.syncDateRange.value = [new Date(2026, 0, 5).getTime(), new Date(2026, 0, 7).getTime()]

    startMock.mockImplementation(async (_url: string, options: { onDone?: (d?: unknown) => void }) => {
      options.onDone?.({
        result: {
          success: 5,
          skipped: 0,
          errors: [],
          warnings: [{ apiName: 'suspend_d_empty', params: { trade_date: '20260106' } }],
        },
      })
    })

    await api.confirmSync()

    // warnings 透传到 finished
    expect(api.finished.value?.result.warnings).toHaveLength(1)
    // errors 为空 → 不弹"N 项失败"，走 success 文案
    expect(message.error).not.toHaveBeenCalled()
    expect(message.success).toHaveBeenCalledWith('基础数据同步完成')
  })

  it('confirmSync 的 error 事件 → message.error + syncing=false，finished 不置位', async () => {
    const message = makeMessage()
    const api = useBaseDataSync(message)
    api.syncDateRange.value = [new Date(2026, 0, 5).getTime(), new Date(2026, 0, 7).getTime()]

    startMock.mockImplementation(async (_url: string, options: { onError?: (m: string) => void }) => {
      options.onError?.('同步失败')
    })

    await api.confirmSync()

    expect(message.error).toHaveBeenCalledWith('同步失败')
    expect(api.syncing.value).toBe(false)
    expect(api.finished.value).toBeNull()
  })

  it('syncProgressVisible: status!==idle 或 finished!==null 时为真', async () => {
    const message = makeMessage()
    const api = useBaseDataSync(message)

    // 初始 idle + 无 finished → false
    setStatus('idle')
    expect(api.syncProgressVisible.value).toBe(false)

    // status 进入 running → true（computed 依赖 statusRef，需触发重算：直接读 + 改值）
    setStatus('running')
    expect(api.syncProgressVisible.value).toBe(true)

    // 回到 idle 但 finished 置位 → 仍为 true
    setStatus('idle')
    api.finished.value = { result: { success: 1, skipped: 0, errors: [] } }
    expect(api.syncProgressVisible.value).toBe(true)
  })

  it('openModal 拉 range，dateRangeLabel 显示 stk_limit 范围，增量默认范围从 max 之后一天起', async () => {
    const message = makeMessage()
    requestMock.mockResolvedValue({
      stkLimit: { min: '20260101', max: '20260105' },
      suspend: { min: '20260101', max: '20260105' },
      tradeCal: { min: '20260101', max: '20260110' },
    })

    const api = useBaseDataSync(message)
    api.openModal()
    // 等待 loadRange 的 await 链跑完
    await Promise.resolve()
    await Promise.resolve()

    expect(api.show.value).toBe(true)
    expect(requestMock).toHaveBeenCalledWith('/api/base-data/range')
    expect(api.dateRangeLabel.value).toContain('stk_limit')
    expect(api.dateRangeLabel.value).toContain('20260101')
    expect(api.dateRangeLabel.value).toContain('20260105')

    // 增量默认起点 = stk_limit.max(20260105) 之后一天 = 20260106
    const range = api.syncDateRange.value!
    const start = new Date(range[0])
    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(0)
    expect(start.getDate()).toBe(6)
  })

  it('openModal 在库存为空(min/max=null)时 dateRangeLabel 提示暂无，默认范围不崩', async () => {
    const message = makeMessage()
    requestMock.mockResolvedValue({
      stkLimit: { min: null, max: null },
      suspend: { min: null, max: null },
      tradeCal: { min: null, max: null },
    })

    const api = useBaseDataSync(message)
    api.openModal()
    await Promise.resolve()
    await Promise.resolve()

    expect(api.dateRangeLabel.value).toContain('暂无')
    // 范围仍是合法的 [number, number]
    expect(api.syncDateRange.value).not.toBeNull()
    expect(typeof api.syncDateRange.value![0]).toBe('number')
    expect(typeof api.syncDateRange.value![1]).toBe('number')
  })
})
