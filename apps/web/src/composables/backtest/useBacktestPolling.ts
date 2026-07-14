import { ref, computed, onBeforeUnmount } from 'vue'
import { backtestApi, type BacktestProgress } from '@/api'

interface UseBacktestPollingOptions {
  /** Called when a backtest reaches done/error or polling errors exceed threshold. */
  onComplete?: (strategyId: string, runId?: string) => void
}

export function useBacktestPolling(options: UseBacktestPollingOptions = {}) {
  const progressMap = ref<Record<string, BacktestProgress>>({})
  const pollErrorCount: Record<string, number> = {}
  const pollingIds = ref(new Set<string>())
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // Progress modal shared state
  const progressModalStrategyId = ref<string | null>(null)
  const progressModalData = ref<BacktestProgress | null>(null)

  const isProgressRunning = computed(() =>
    !!progressModalStrategyId.value && pollingIds.value.has(progressModalStrategyId.value),
  )

  function checkStopTimer() {
    if (!pollingIds.value.size && pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function pollTick() {
    for (const id of pollingIds.value) {
      try {
        const p = await backtestApi.getProgress(id)
        pollErrorCount[id] = 0
        if (!p) {
          pollingIds.value.delete(id)
          const updated = { ...progressMap.value }
          delete updated[id]
          progressMap.value = updated
          if (progressModalStrategyId.value === id) progressModalData.value = null
          checkStopTimer()
          continue
        }
        progressMap.value = { ...progressMap.value, [id]: p }
        if (progressModalStrategyId.value === id) progressModalData.value = p
        if (p.status === 'done' || p.status === 'error') {
          pollingIds.value.delete(id)
          checkStopTimer()
          options.onComplete?.(id, p.runId)
        }
      } catch {
        pollErrorCount[id] = (pollErrorCount[id] ?? 0) + 1
        if (pollErrorCount[id] >= 3) {
          const errProgress = { ...progressMap.value[id], status: 'error' as const, message: '进度查询失败' }
          progressMap.value = { ...progressMap.value, [id]: errProgress }
          if (progressModalStrategyId.value === id) progressModalData.value = errProgress
          pollingIds.value.delete(id)
          checkStopTimer()
          options.onComplete?.(id)
        }
      }
    }
  }

  function startPolling(strategyId: string) {
    pollingIds.value.add(strategyId)
    pollErrorCount[strategyId] = 0
    if (!pollTimer) {
      void pollTick()
      pollTimer = setInterval(() => void pollTick(), 500)
    }
  }

  function stopPolling(strategyId: string) {
    pollingIds.value.delete(strategyId)
    checkStopTimer()
  }

  onBeforeUnmount(() => {
    if (pollTimer !== null) clearInterval(pollTimer)
  })

  return {
    progressMap,
    pollingIds,
    isProgressRunning,
    progressModalStrategyId,
    progressModalData,
    startPolling,
    stopPolling,
  }
}
