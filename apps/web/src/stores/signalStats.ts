import { defineStore } from 'pinia'
import { ref } from 'vue'
import { signalStatsApi } from '../api/modules/strategy/signalStats'
import type {
  SignalTestRun,
  CreateSignalTestDto,
  UpdateSignalTestDto,
  SignalTestWithLatestRun,
  RetHistogramResult,
  ListTradesParams,
} from '../api/modules/strategy/signalStats'

export const useSignalStatsStore = defineStore('signalStats', () => {
  const tests = ref<SignalTestWithLatestRun[]>([])
  const runningId = ref<string | null>(null)
  const loading = ref(false)
  const lastPollError = ref<string | null>(null)

  // histogram keyed by runId
  const histogramMap = ref<Record<string, RetHistogramResult>>({})

  async function fetchTests() {
    loading.value = true
    try {
      const data = await signalStatsApi.findAll()
      tests.value = data
    } finally {
      loading.value = false
    }
  }

  async function createTest(dto: CreateSignalTestDto) {
    const data = await signalStatsApi.create(dto)
    tests.value.unshift({ ...data, latestRun: null })
    return data
  }

  async function updateTest(id: string, dto: UpdateSignalTestDto) {
    const data = await signalStatsApi.update(id, dto)
    const idx = tests.value.findIndex((t) => t.id === id)
    if (idx !== -1) {
      const existing = tests.value[idx]
      tests.value[idx] = { ...data, latestRun: existing.latestRun ?? null }
    }
    return data
  }

  async function deleteTest(id: string) {
    await signalStatsApi.remove(id)
    tests.value = tests.value.filter((t) => t.id !== id)
  }

  /** Patch the polled run entity into the matching test's latestRun (reactive). */
  function patchLatestRun(testId: string, run: SignalTestRun) {
    const t = tests.value.find((x) => x.id === testId)
    if (t) t.latestRun = run
  }

  async function startRun(id: string) {
    runningId.value = id
    lastPollError.value = null
    try {
      const { runId } = await signalStatsApi.triggerRun(id)

      const poll = setInterval(async () => {
        try {
          // Backend returns the full run entity here; patch it into the matching
          // test's latestRun so both the table row and an open detail update live.
          const progressRun = await signalStatsApi.getRunProgress(id)
          patchLatestRun(id, progressRun)

          if (progressRun.status === 'completed' || progressRun.status === 'failed') {
            clearInterval(poll)
            runningId.value = null
            // The patched run is already the complete finished entity; no extra
            // fetchTests needed (filteredCount etc. are part of the run entity).
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '轮询进度失败'
          lastPollError.value = msg
          // eslint-disable-next-line no-console
          console.warn(`[signalStats] poll progress failed for ${id}: ${msg}`)
          clearInterval(poll)
          runningId.value = null
        }
      }, 500)

      // 10 min safety timeout (signal stats can take longer than strategy conditions)
      setTimeout(
        () => {
          clearInterval(poll)
          if (runningId.value === id) {
            runningId.value = null
            if (!lastPollError.value) lastPollError.value = '运行轮询超时（10min）'
          }
        },
        10 * 60 * 1000,
      )

      return { runId }
    } catch {
      runningId.value = null
      throw new Error('启动运行失败')
    }
  }

  async function fetchRetHistogram(runId: string) {
    if (histogramMap.value[runId]) {
      return histogramMap.value[runId]
    }
    const data = await signalStatsApi.getRetHistogram(runId)
    histogramMap.value[runId] = data
    return data
  }

  async function fetchTrades(runId: string, params: ListTradesParams = {}) {
    return signalStatsApi.listTrades(runId, params)
  }

  return {
    tests,
    runningId,
    loading,
    lastPollError,
    histogramMap,
    fetchTests,
    createTest,
    updateTest,
    deleteTest,
    startRun,
    fetchRetHistogram,
    fetchTrades,
  }
})
