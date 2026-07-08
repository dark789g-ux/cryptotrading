/**
 * strategyConditions store 单测（TODO.md「一、正确性问题」回归守卫）。
 *
 * 覆盖：
 * - startRun 成功 → runningIds 含 id；轮询到 completed 终态后 runningIds 清空、
 *   runProgress 删除该 id、fetchLastRunStatus 被调（问题 1/2/9）。
 * - 终态 failed → lastPollErrors[conditionId] 承载后端 errorMessage（问题 1 方案 B + 问题 8 数据源）。
 * - 连续失败 <5 次不中断；第 5 次才放弃并同步状态、不误判任务失败（问题 3）。
 * - 成功一次即归零计数（瞬时抖动不累积）。
 * - resumeRunningPolls：对 freshness==='running' 的 id 重建轮询且不重复 POST startRun（问题 2）。
 * - 多个 running id 并存（问题 5 前端 Set 语义）。
 * - startRun 返回 status=queued 时仍启轮询，queued→running→completed 正确流转。
 * - 递归 setTimeout 串行化：慢响应下不会触发并发轮询。
 *
 * mock api client（../../api/modules/strategy/strategyConditions），用 vi.useFakeTimers 驱动两段式轮询。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const { startRunMock, getRunProgressMock, getLastRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  getRunProgressMock: vi.fn(),
  getLastRunStatusMock: vi.fn(),
}))

vi.mock('../../api/modules/strategy/strategyConditions', () => ({
  strategyConditionsApi: {
    startRun: startRunMock,
    getRunProgress: getRunProgressMock,
    getLastRunStatus: getLastRunStatusMock,
  },
}))

import { useStrategyConditionsStore } from '../strategyConditions'
import type { RunProgress, LastRunStatus } from '../../api/modules/strategy/strategyConditions'

/** 两段式自适应轮询常量（与 store 内一致）。 */
const FAST_POLL_MS = 400
const SLOW_POLL_MS = 1500
const FAST_POLL_COUNT = 5

/** 推进 N 次轮询，按两段式自适应间隔：
 *  pollCount 仅在成功时 +1，失败不推进。
 *  简化处理：纯失败场景一直快间隔 400；纯成功场景前 5 次快、之后慢。
 *  多数测试只推进 1-2 次都在快间隔内，少数测稳态的才需推进 >5 次。 */
async function advancePolls(count: number) {
  // 纯失败场景下 pollCount 不增长，始终快间隔；测试中不区分成功失败，
  // 统一前 FAST_POLL_COUNT 次快间隔、之后慢间隔。
  for (let i = 0; i < count; i++) {
    const delay = i < FAST_POLL_COUNT ? FAST_POLL_MS : SLOW_POLL_MS
    await vi.advanceTimersByTimeAsync(delay)
  }
}

function makeProgress(over: Partial<RunProgress> = {}): RunProgress {
  return {
    runId: 'run-1',
    status: 'running',
    progressScanned: 100,
    progressTotal: 5000,
    totalHits: 0,
    errorMessage: undefined,
    ...over,
  }
}

function makeLastRunStatus(conditionId: string, over: Partial<LastRunStatus> = {}): LastRunStatus {
  return {
    conditionId,
    freshness: 'fresh',
    lastRunAt: '2026-07-08T00:00:00.000Z',
    totalHits: 0,
    ...over,
  }
}

describe('strategyConditions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    startRunMock.mockReset()
    getRunProgressMock.mockReset()
    getLastRunStatusMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('startRun 成功 → runningIds 含 id；终态 completed 后清理并同步状态', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-1', status: 'running' })
    getRunProgressMock.mockResolvedValue(makeProgress())
    getLastRunStatusMock.mockResolvedValue([makeLastRunStatus('c1')])

    const store = useStrategyConditionsStore()
    await store.startRun('c1')

    expect(startRunMock).toHaveBeenCalledWith('c1')
    expect(store.isRunning('c1')).toBe(true)
    expect(store.runningIds.has('c1')).toBe(true)

    // 轮询一次写入 progress（第一次快间隔 400ms）
    await advancePolls(1)
    expect(getRunProgressMock).toHaveBeenCalledWith('c1')
    expect(store.runProgress.get('c1')?.progressScanned).toBe(100)

    // 终态 completed → 停轮询 + 清 runProgress + 同步状态
    getRunProgressMock.mockResolvedValue(makeProgress({ status: 'completed', totalHits: 8 }))
    getLastRunStatusMock.mockResolvedValue([makeLastRunStatus('c1', { freshness: 'fresh', totalHits: 8 })])
    await advancePolls(1)

    expect(store.isRunning('c1')).toBe(false)
    expect(store.runProgress.has('c1')).toBe(false) // 问题 9：终态清理
    expect(getLastRunStatusMock).toHaveBeenCalled()

    // 已停轮询：再推进时间不应再调 getRunProgress
    const callsAfterTerminal = getRunProgressMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(getRunProgressMock.mock.calls.length).toBe(callsAfterTerminal)
  })

  it('终态 failed → lastPollErrors[conditionId] 承载后端 errorMessage', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-1', status: 'running' })
    getRunProgressMock.mockResolvedValue(
      makeProgress({ status: 'failed', errorMessage: '数据库连接超时' }),
    )
    getLastRunStatusMock.mockResolvedValue([makeLastRunStatus('c1', { freshness: 'failed' })])

    const store = useStrategyConditionsStore()
    store.lastPollErrors.delete('c1')
    await store.startRun('c1')
    await advancePolls(1)

    expect(store.isRunning('c1')).toBe(false)
    expect(store.getLastError('c1')).toBe('数据库连接超时')
  })

  it('连续失败 <5 次不中断轮询；中间成功即归零', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-1', status: 'running' })
    getLastRunStatusMock.mockResolvedValue([makeLastRunStatus('c1', { freshness: 'running' })])

    const store = useStrategyConditionsStore()
    await store.startRun('c1')

    // 连续 4 次失败：不应中断
    // 失败不推进 pollCount，始终快间隔 400ms
    getRunProgressMock.mockRejectedValue(new Error('网络抖动'))
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    }
    expect(store.isRunning('c1')).toBe(true)
    expect(store.getLastError('c1')).toBeUndefined() // 中间失败不写 lastPollErrors

    // 第 5 次成功 → 计数归零，继续轮询（pollCount 变 1，仍在快间隔内）
    getRunProgressMock.mockResolvedValue(makeProgress({ progressScanned: 200 }))
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    expect(store.isRunning('c1')).toBe(true)

    // 再连续 4 次失败仍不应中断（证明计数已归零，非累积）
    getRunProgressMock.mockRejectedValue(new Error('再次抖动'))
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    }
    expect(store.isRunning('c1')).toBe(true)
  })

  it('连续失败达 5 次才放弃，并同步状态（不误判任务失败）', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-1', status: 'running' })
    // 放弃时 fetchLastRunStatus 返回后端仍是 running（任务实际没失败）
    getLastRunStatusMock.mockResolvedValue([makeLastRunStatus('c1', { freshness: 'running' })])

    const store = useStrategyConditionsStore()
    await store.startRun('c1')

    getRunProgressMock.mockRejectedValue(new Error('网络断了'))
    // 失败不推进 pollCount，始终快间隔 400ms
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    }

    expect(store.isRunning('c1')).toBe(false) // 放弃轮询
    expect(getLastRunStatusMock).toHaveBeenCalled() // 同步真实状态
    expect(store.getLastError('c1')).toContain('连续失败 5 次') // 提示信息，非判任务失败

    // 已停轮询
    const callsAfterGiveUp = getRunProgressMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(getRunProgressMock.mock.calls.length).toBe(callsAfterGiveUp)
  })

  it('resumeRunningPolls：对 running 的 id 重建轮询，不重复 POST startRun', async () => {
    getLastRunStatusMock.mockResolvedValue([
      makeLastRunStatus('c1', { freshness: 'running' }),
      makeLastRunStatus('c2', { freshness: 'fresh' }),
    ])
    getRunProgressMock.mockResolvedValue(makeProgress())

    const store = useStrategyConditionsStore()
    await store.fetchLastRunStatus()

    // 恢复前无任何运行中
    expect(store.isRunning('c1')).toBe(false)

    store.resumeRunningPolls()
    // 仅 c1（running）恢复轮询
    expect(store.isRunning('c1')).toBe(true)
    expect(store.isRunning('c2')).toBe(false)
    // 不应调用 startRun（避免重复触发后端 run）
    expect(startRunMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    expect(getRunProgressMock).toHaveBeenCalledWith('c1')
    expect(getRunProgressMock).not.toHaveBeenCalledWith('c2')
  })

  it('多个 running id 可并存（问题 5 前端 Set 语义）', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-x', status: 'running' })
    getRunProgressMock.mockResolvedValue(makeProgress())

    const store = useStrategyConditionsStore()
    await store.startRun('c1')
    await store.startRun('c2')

    expect(store.isRunning('c1')).toBe(true)
    expect(store.isRunning('c2')).toBe(true)
    expect(store.runningIds.size).toBe(2)

    // c1 终态不影响 c2
    getRunProgressMock.mockImplementation(async (id: string) =>
      id === 'c1'
        ? makeProgress({ runId: 'r1', status: 'completed' })
        : makeProgress({ runId: 'r2', status: 'running' }),
    )
    getLastRunStatusMock.mockResolvedValue([
      makeLastRunStatus('c1', { freshness: 'fresh' }),
      makeLastRunStatus('c2', { freshness: 'running' }),
    ])
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)

    expect(store.isRunning('c1')).toBe(false)
    expect(store.isRunning('c2')).toBe(true)
  })

  it('startRun 启动失败（如后端 409）→ runningIds 回滚 + 透传错误', async () => {
    startRunMock.mockRejectedValue(new Error('该策略条件已有运行中的任务'))

    const store = useStrategyConditionsStore()
    await expect(store.startRun('c1')).rejects.toThrow('该策略条件已有运行中的任务')
    expect(store.isRunning('c1')).toBe(false)
  })

  it('startRun 返回 status=queued 时仍启轮询，且 queued→running→completed 正确流转', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-1', status: 'queued' })
    // 第一次轮询：queued（不视为终态，继续）
    getRunProgressMock.mockResolvedValueOnce(makeProgress({ status: 'queued', progressScanned: 0 }))
    // 第二次：running
    getRunProgressMock.mockResolvedValueOnce(makeProgress({ status: 'running', progressScanned: 100 }))
    // 第三次：completed
    getRunProgressMock.mockResolvedValueOnce(makeProgress({ status: 'completed', totalHits: 5 }))
    getLastRunStatusMock.mockResolvedValue([makeLastRunStatus('c1', { freshness: 'fresh' })])

    const store = useStrategyConditionsStore()
    const res = await store.startRun('c1')
    expect(res.status).toBe('queued')
    expect(store.isRunning('c1')).toBe(true)

    // queued 推进一次：继续轮询
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    expect(store.runProgress.get('c1')?.status).toBe('queued')
    expect(store.isRunning('c1')).toBe(true) // 仍在轮询

    // running 推进
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    expect(store.runProgress.get('c1')?.progressScanned).toBe(100)

    // completed 终态
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    expect(store.isRunning('c1')).toBe(false)
    expect(store.runProgress.has('c1')).toBe(false)
  })

  it('递归 setTimeout：慢响应下两次轮询不重叠（串行化）', async () => {
    startRunMock.mockResolvedValue({ runId: 'run-1', status: 'running' })

    // 第一次 getRunProgress 延迟返回（模拟慢响应），期间推进时间不应触发第二次
    let resolveFirst!: (v: RunProgress) => void
    getRunProgressMock.mockReturnValueOnce(new Promise<RunProgress>(r => { resolveFirst = r }))

    const store = useStrategyConditionsStore()
    await store.startRun('c1')

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS) // 触发第一次 tick，promise pending
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3) // 推进更多时间，但第一次还没返回
    expect(getRunProgressMock).toHaveBeenCalledTimes(1) // 仍只调了一次，无并发

    // resolve 第一次的 pending promise，然后推进 0ms 让 microtask queue 处理完
    resolveFirst(makeProgress({ progressScanned: 100 }))
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // 第一次完成后才会调度第二次
    getRunProgressMock.mockResolvedValue(makeProgress({ progressScanned: 200 }))
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS)
    expect(getRunProgressMock).toHaveBeenCalledTimes(2)
  })
})
