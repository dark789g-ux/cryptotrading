/**
 * usePortfolioSimSourceRuns 单测：
 * 「组合模拟直接设置信号源」底层逻辑层（纯逻辑，不挂任何 .vue）。
 *
 * 覆盖：
 *  路径A loadRuns —— 缓存命中不二次请求、force 强制刷新、不同 testId 各自缓存
 *  latestCompleted —— 混合状态取最新 completed、全非 completed 返回 null、空列表返回 null
 *  路径B startPolling —— 2s 节拍 onUpdate、到 completed/failed 自动停、连续失败 N 次停并 onError、
 *                        成功重置失败计数、重复 startPolling 同 testId 先停旧的、stopPolling/stopAll 清理 interval
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SignalTestRun } from '@/api/modules/strategy/signalStats'

// mock API 封装（hoisted）
const listRuns = vi.fn()
const getRunProgress = vi.fn()
vi.mock('@/api/modules/strategy/signalStats', () => ({
  signalStatsApi: {
    listRuns: (id: string) => listRuns(id),
    getRunProgress: (id: string) => getRunProgress(id),
  },
}))

import { usePortfolioSimSourceRuns } from './usePortfolioSimSourceRuns'

/** 造一个最小可用的 SignalTestRun（只填测试关心的字段，其余给合理默认）。 */
function makeRun(over: Partial<SignalTestRun> & Pick<SignalTestRun, 'id' | 'status'>): SignalTestRun {
  return {
    id: over.id,
    testId: over.testId ?? 'test-1',
    status: over.status,
    progressScanned: over.progressScanned ?? 0,
    progressTotal: over.progressTotal ?? 0,
    phase: over.phase ?? null,
    errorMessage: over.errorMessage ?? null,
    sampleCount: over.sampleCount ?? null,
    winRate: over.winRate ?? null,
    avgWin: over.avgWin ?? null,
    avgLoss: over.avgLoss ?? null,
    payoffRatio: over.payoffRatio ?? null,
    profitFactor: over.profitFactor ?? null,
    kellyF: over.kellyF ?? null,
    avgHoldDays: over.avgHoldDays ?? null,
    worstTradeRet: over.worstTradeRet ?? null,
    bestTradeRet: over.bestTradeRet ?? null,
    filteredCount: over.filteredCount ?? 0,
    createdAt: over.createdAt ?? '2026-06-14T00:00:00.000Z',
    completedAt: over.completedAt ?? null,
  }
}

describe('usePortfolioSimSourceRuns - loadRuns 缓存', () => {
  beforeEach(() => {
    listRuns.mockReset()
    getRunProgress.mockReset()
  })

  it('同 testId 二次调用命中缓存，不再请求', async () => {
    const runs = [makeRun({ id: 'r1', status: 'completed' })]
    listRuns.mockResolvedValue(runs)
    const api = usePortfolioSimSourceRuns()

    const first = await api.loadRuns('test-1')
    const second = await api.loadRuns('test-1')

    expect(listRuns).toHaveBeenCalledTimes(1)
    expect(first).toEqual(runs)
    expect(second).toEqual(runs)
  })

  it('force:true 强制重新请求', async () => {
    listRuns.mockResolvedValue([makeRun({ id: 'r1', status: 'completed' })])
    const api = usePortfolioSimSourceRuns()

    await api.loadRuns('test-1')
    await api.loadRuns('test-1', { force: true })

    expect(listRuns).toHaveBeenCalledTimes(2)
  })

  it('不同 testId 各自独立缓存', async () => {
    listRuns.mockImplementation((id: string) => Promise.resolve([makeRun({ id: `r-${id}`, status: 'completed' })]))
    const api = usePortfolioSimSourceRuns()

    await api.loadRuns('test-1')
    await api.loadRuns('test-2')
    await api.loadRuns('test-1') // 命中缓存
    await api.loadRuns('test-2') // 命中缓存

    expect(listRuns).toHaveBeenCalledTimes(2)
    expect(listRuns).toHaveBeenCalledWith('test-1')
    expect(listRuns).toHaveBeenCalledWith('test-2')
  })

  it('请求失败不写缓存，下次仍会重试', async () => {
    listRuns.mockRejectedValueOnce(new Error('boom'))
    const api = usePortfolioSimSourceRuns()

    await expect(api.loadRuns('test-1')).rejects.toThrow('boom')

    const runs = [makeRun({ id: 'r1', status: 'completed' })]
    listRuns.mockResolvedValue(runs)
    const ok = await api.loadRuns('test-1')

    expect(listRuns).toHaveBeenCalledTimes(2)
    expect(ok).toEqual(runs)
  })

  it('并发同 testId 只发一次请求（in-flight 去重）', async () => {
    let resolveFn: (v: SignalTestRun[]) => void = () => {}
    listRuns.mockReturnValue(new Promise<SignalTestRun[]>((res) => { resolveFn = res }))
    const api = usePortfolioSimSourceRuns()

    const p1 = api.loadRuns('test-1')
    const p2 = api.loadRuns('test-1')
    resolveFn([makeRun({ id: 'r1', status: 'completed' })])
    await Promise.all([p1, p2])

    expect(listRuns).toHaveBeenCalledTimes(1)
  })
})

describe('usePortfolioSimSourceRuns - latestCompleted', () => {
  const api = usePortfolioSimSourceRuns()

  it('混合状态列表（DESC）取第一个 completed', () => {
    const runs = [
      makeRun({ id: 'r3', status: 'running', createdAt: '2026-06-14T03:00:00.000Z' }),
      makeRun({ id: 'r2', status: 'completed', createdAt: '2026-06-14T02:00:00.000Z' }),
      makeRun({ id: 'r1', status: 'completed', createdAt: '2026-06-14T01:00:00.000Z' }),
    ]
    expect(api.latestCompleted(runs)?.id).toBe('r2')
  })

  it('全非 completed 返回 null', () => {
    const runs = [
      makeRun({ id: 'r2', status: 'running' }),
      makeRun({ id: 'r1', status: 'failed' }),
    ]
    expect(api.latestCompleted(runs)).toBeNull()
  })

  it('空列表返回 null', () => {
    expect(api.latestCompleted([])).toBeNull()
  })
})

describe('usePortfolioSimSourceRuns - startPolling 路径B', () => {
  beforeEach(() => {
    listRuns.mockReset()
    getRunProgress.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('每 2s 调一次 getRunProgress，onUpdate 拿到最新 run', async () => {
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'running', progressScanned: 10 }))
    const api = usePortfolioSimSourceRuns()
    const onUpdate = vi.fn()

    api.startPolling('test-1', { onUpdate })

    // 1s 时还没到节拍
    await vi.advanceTimersByTimeAsync(1000)
    expect(getRunProgress).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(1000) // 累计 2s
    expect(getRunProgress).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0].id).toBe('r1')

    await vi.advanceTimersByTimeAsync(2000) // 累计 4s
    expect(getRunProgress).toHaveBeenCalledTimes(2)

    api.stopAll()
  })

  it('status=completed 即自动停（不再轮询）', async () => {
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'completed' }))
    const api = usePortfolioSimSourceRuns()
    const onUpdate = vi.fn()

    api.startPolling('test-1', { onUpdate })
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunProgress).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // 终态后再推进时间不应继续请求
    await vi.advanceTimersByTimeAsync(6000)
    expect(getRunProgress).toHaveBeenCalledTimes(1)
  })

  it('status=failed 即自动停（终态判断认 failed 不认 error）', async () => {
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'failed', errorMessage: 'x' }))
    const api = usePortfolioSimSourceRuns()
    const onUpdate = vi.fn()

    api.startPolling('test-1', { onUpdate })
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunProgress).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6000)
    expect(getRunProgress).toHaveBeenCalledTimes(1) // 不泄漏
  })

  it('连续失败 5 次后停并回调 onError', async () => {
    getRunProgress.mockRejectedValue(new Error('net down'))
    const api = usePortfolioSimSourceRuns()
    const onUpdate = vi.fn()
    const onError = vi.fn()

    api.startPolling('test-1', { onUpdate, onError })

    // 前 4 次失败：仍在轮询，未触发 onError
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(2000)
      expect(getRunProgress).toHaveBeenCalledTimes(i)
      expect(onError).not.toHaveBeenCalled()
    }
    // 第 5 次失败：停 + onError
    await vi.advanceTimersByTimeAsync(2000)
    expect(getRunProgress).toHaveBeenCalledTimes(5)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)

    // 已停：再推进不请求
    await vi.advanceTimersByTimeAsync(10000)
    expect(getRunProgress).toHaveBeenCalledTimes(5)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('成功后失败计数重置：4 失败 + 1 成功 + 再 4 失败仍不停', async () => {
    const api = usePortfolioSimSourceRuns()
    const onError = vi.fn()
    const onUpdate = vi.fn()

    // 4 次失败
    getRunProgress.mockRejectedValue(new Error('flap'))
    api.startPolling('test-1', { onUpdate, onError })
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(2000)
    expect(onError).not.toHaveBeenCalled()

    // 1 次成功（running，不终态）→ 重置计数
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'running' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // 再 4 次失败：因已重置，仍不到阈值，不停不报
    getRunProgress.mockRejectedValue(new Error('flap2'))
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(2000)
    expect(onError).not.toHaveBeenCalled()

    api.stopAll()
  })

  it('重复 startPolling 同一 testId：先停旧的，只有一个 interval', async () => {
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'running' }))
    const api = usePortfolioSimSourceRuns()
    const onUpdate = vi.fn()

    api.startPolling('test-1', { onUpdate })
    api.startPolling('test-1', { onUpdate }) // 应先停旧的

    await vi.advanceTimersByTimeAsync(2000)
    // 若两个 interval 并存会被调用 2 次；正确实现只调 1 次
    expect(getRunProgress).toHaveBeenCalledTimes(1)

    api.stopAll()
  })

  it('stopPolling(testId) 停掉对应 interval', async () => {
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'running' }))
    const api = usePortfolioSimSourceRuns()
    const onUpdate = vi.fn()

    api.startPolling('test-1', { onUpdate })
    api.stopPolling('test-1')

    await vi.advanceTimersByTimeAsync(6000)
    expect(getRunProgress).not.toHaveBeenCalled()
  })

  it('stopAll 停掉多个 testId 的 interval', async () => {
    getRunProgress.mockResolvedValue(makeRun({ id: 'r1', status: 'running' }))
    const api = usePortfolioSimSourceRuns()

    api.startPolling('test-1', { onUpdate: vi.fn() })
    api.startPolling('test-2', { onUpdate: vi.fn() })
    api.stopAll()

    await vi.advanceTimersByTimeAsync(6000)
    expect(getRunProgress).not.toHaveBeenCalled()
  })

  it('多个 testId 并行轮询互不干扰', async () => {
    getRunProgress.mockImplementation((id: string) => Promise.resolve(makeRun({ id: `run-${id}`, status: 'running' })))
    const api = usePortfolioSimSourceRuns()
    const onUpdate1 = vi.fn()
    const onUpdate2 = vi.fn()

    api.startPolling('test-1', { onUpdate: onUpdate1 })
    api.startPolling('test-2', { onUpdate: onUpdate2 })

    await vi.advanceTimersByTimeAsync(2000)
    expect(onUpdate1).toHaveBeenCalledTimes(1)
    expect(onUpdate2).toHaveBeenCalledTimes(1)
    expect(onUpdate1.mock.calls[0][0].id).toBe('run-test-1')
    expect(onUpdate2.mock.calls[0][0].id).toBe('run-test-2')

    api.stopAll()
  })
})
