/**
 * usePortfolioSimSourceRuns —— 「组合模拟直接设置信号源」的纯逻辑层。
 *
 * 提供两条路径所需的无 UI 逻辑（不依赖任何具体组件，可在 setup 内调用）：
 *   路径A：loadRuns(testId) 拉某方案全部历史 run（带缓存），latestCompleted() 取最新 completed
 *   路径B：startPolling(testId) 每 2s 轮询该方案当前 run 进度，到终态或连续失败 N 次自动停
 *
 * 轮询契约（与 stores/portfolioSim.ts、stores/signalStats.ts 保持一致）：
 *   - 间隔固定 2000ms
 *   - 终态判断用 status === 'completed' || status === 'failed'（失败态是 'failed' 不是 'error'）
 *   - 连续失败达 MAX_CONSECUTIVE_POLL_ERRORS（5）次才停，停时经 onError 透出，成功即重置计数
 *   - 同一 testId 同时只允许一个 interval；重复 startPolling 先停旧的再起新的
 */
import { signalStatsApi } from '@/api/modules/strategy/signalStats'
import type { SignalTestRun } from '@/api/modules/strategy/signalStats'

const POLL_INTERVAL_MS = 2000
const MAX_CONSECUTIVE_POLL_ERRORS = 5

/** run 是否处于终态（completed / failed）。 */
function isTerminal(run: SignalTestRun): boolean {
  return run.status === 'completed' || run.status === 'failed'
}

interface PollHandlers {
  onUpdate: (run: SignalTestRun) => void
  onError?: (err: Error) => void
}

interface PollEntry {
  timer: ReturnType<typeof setInterval>
  consecutiveFailures: number
}

export function usePortfolioSimSourceRuns() {
  // 路径A：已完成请求的结果缓存 + 进行中请求去重（同 testId 并发只发一次）
  const runsCache = new Map<string, SignalTestRun[]>()
  const inFlight = new Map<string, Promise<SignalTestRun[]>>()

  // 路径B：每 testId 一个轮询条目
  const pollers = new Map<string, PollEntry>()

  /** 路径A：拉该方案全部 run（createdAt DESC）。同 testId 命中缓存不重复请求；force 强制刷新。 */
  function loadRuns(testId: string, opts?: { force?: boolean }): Promise<SignalTestRun[]> {
    if (!opts?.force) {
      const cached = runsCache.get(testId)
      if (cached) return Promise.resolve(cached)
      const pending = inFlight.get(testId)
      if (pending) return pending
    }
    const req = signalStatsApi
      .listRuns(testId)
      .then((runs) => {
        runsCache.set(testId, runs)
        return runs
      })
      .finally(() => {
        // 仅当这次仍是登记中的 in-flight 时才清除，避免误清后发起的请求
        if (inFlight.get(testId) === req) inFlight.delete(testId)
      })
    inFlight.set(testId, req)
    return req
  }

  /** 从 run 列表（listRuns 已按 createdAt DESC）取最新 completed run，无则 null。 */
  function latestCompleted(runs: SignalTestRun[]): SignalTestRun | null {
    return runs.find((r) => r.status === 'completed') ?? null
  }

  /** 路径B：按 testId 轮询 getRunProgress；到终态或连续失败 N 次自动停。 */
  function startPolling(testId: string, handlers: PollHandlers): void {
    // 同一 testId 只允许一个 interval：先停旧的再起新的
    stopPolling(testId)

    const entry: PollEntry = {
      timer: setInterval(() => {
        void tick(testId, entry, handlers)
      }, POLL_INTERVAL_MS),
      consecutiveFailures: 0,
    }
    pollers.set(testId, entry)
  }

  /** 单次轮询：拉进度 → onUpdate；终态停；失败累计到阈值停 + onError；成功重置计数。 */
  async function tick(testId: string, entry: PollEntry, handlers: PollHandlers): Promise<void> {
    try {
      const run = await signalStatsApi.getRunProgress(testId)
      // await 期间可能已被 stopPolling/被新一轮 startPolling 替换，过期则不再处理
      if (pollers.get(testId) !== entry) return
      entry.consecutiveFailures = 0
      handlers.onUpdate(run)
      if (isTerminal(run)) stopPolling(testId)
    } catch (err) {
      if (pollers.get(testId) !== entry) return
      if (++entry.consecutiveFailures >= MAX_CONSECUTIVE_POLL_ERRORS) {
        stopPolling(testId)
        handlers.onError?.(err instanceof Error ? err : new Error('轮询进度失败'))
      }
    }
  }

  /** 停掉指定 testId 的轮询（clearInterval）。 */
  function stopPolling(testId: string): void {
    const entry = pollers.get(testId)
    if (entry) {
      clearInterval(entry.timer)
      pollers.delete(testId)
    }
  }

  /** 停掉全部轮询（组件 onUnmounted 调用）。 */
  function stopAll(): void {
    for (const entry of pollers.values()) clearInterval(entry.timer)
    pollers.clear()
  }

  return {
    loadRuns,
    latestCompleted,
    startPolling,
    stopPolling,
    stopAll,
  }
}
