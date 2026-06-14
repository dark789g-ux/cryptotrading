/**
 * usePortfolioSimSourceRuns —— 「组合模拟设置信号源」的纯逻辑层。
 *
 * 提供「选已有方案 + 历史 run」路径所需的无 UI 逻辑（不依赖任何具体组件，可在 setup 内调用）：
 *   loadRuns(testId)      拉某方案全部历史 run（带缓存 + in-flight 去重）
 *   latestCompleted(runs) 从列表取最新 completed
 *
 * 终态口径（与 stores/portfolioSim.ts、stores/signalStats.ts 一致）：
 *   completed / failed（失败态是 'failed' 不是 'error'）。
 *
 * 注：内联「新建信号源」路径（路径B 轮询）已随 spec 05 §5.5 移除——用户改在
 * 「信号统计」页新建并运行方案，跑完回组合模拟选用历史 run，故本层不再含 startPolling。
 */
import { signalStatsApi } from '@/api/modules/strategy/signalStats'
import type { SignalTestRun } from '@/api/modules/strategy/signalStats'

export function usePortfolioSimSourceRuns() {
  // 已完成请求的结果缓存 + 进行中请求去重（同 testId 并发只发一次）
  const runsCache = new Map<string, SignalTestRun[]>()
  const inFlight = new Map<string, Promise<SignalTestRun[]>>()

  /** 拉该方案全部 run（createdAt DESC）。同 testId 命中缓存不重复请求；force 强制刷新。 */
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

  return {
    loadRuns,
    latestCompleted,
  }
}
