/**
 * usePortfolioSimSourceRuns 单测：
 * 「组合模拟设置信号源」底层逻辑层（纯逻辑，不挂任何 .vue）。
 *
 * 覆盖：
 *  loadRuns —— 缓存命中不二次请求、force 强制刷新、不同 testId 各自缓存、失败不写缓存、并发去重
 *  latestCompleted —— 混合状态取最新 completed、全非 completed 返回 null、空列表返回 null
 *
 * 注：内联「新建信号源」路径（路径B startPolling 轮询）已随 spec 05 §5.5 移除，对应单测同步删除。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SignalTestRun } from '@/api/modules/strategy/signalStats'

// mock API 封装（hoisted）
const listRuns = vi.fn()
vi.mock('@/api/modules/strategy/signalStats', () => ({
  signalStatsApi: {
    listRuns: (id: string) => listRuns(id),
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
    // 迷你回测层指标（Part A 扩展，本逻辑层不关心，给 null/默认占位）
    finalNav: over.finalNav ?? null,
    totalRet: over.totalRet ?? null,
    annualRet: over.annualRet ?? null,
    maxDrawdown: over.maxDrawdown ?? null,
    sharpe: over.sharpe ?? null,
    calmar: over.calmar ?? null,
    dailyWinRate: over.dailyWinRate ?? null,
    dailyKelly: over.dailyKelly ?? null,
    nTaken: over.nTaken ?? null,
    nSkipped: over.nSkipped ?? null,
    totalCosts: over.totalCosts ?? null,
    filteredCount: over.filteredCount ?? 0,
    createdAt: over.createdAt ?? '2026-06-14T00:00:00.000Z',
    completedAt: over.completedAt ?? null,
  }
}

describe('usePortfolioSimSourceRuns - loadRuns 缓存', () => {
  beforeEach(() => {
    listRuns.mockReset()
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
