import { defineStore } from 'pinia'
import { ref } from 'vue'
import { signalStatsApi } from '../api/modules/strategy/signalStats'
import type {
  SignalTest,
  SignalTestRun,
  SignalTestRunProgress,
  SignalTestTrade,
  CreateSignalTestDto,
  UpdateSignalTestDto,
  TradesPage,
} from '../api/modules/strategy/signalStats'

export const useSignalStatsStore = defineStore('signalStats', () => {
  const tests = ref<SignalTest[]>([])
  const runProgress = ref<Map<string, SignalTestRunProgress>>(new Map())
  const runningId = ref<string | null>(null)
  const loading = ref(false)
  const lastPollError = ref<string | null>(null)

  // runs & trades keyed by testId / runId
  const runsMap = ref<Map<string, SignalTestRun[]>>(new Map())
  const tradesMap = ref<Map<string, TradesPage>>(new Map())

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
    tests.value.unshift(data)
    return data
  }

  async function updateTest(id: string, dto: UpdateSignalTestDto) {
    const data = await signalStatsApi.update(id, dto)
    const idx = tests.value.findIndex((t) => t.id === id)
    if (idx !== -1) tests.value[idx] = data
    return data
  }

  async function deleteTest(id: string) {
    await signalStatsApi.remove(id)
    tests.value = tests.value.filter((t) => t.id !== id)
    runProgress.value.delete(id)
    runsMap.value.delete(id)
  }

  async function startRun(id: string) {
    runningId.value = id
    lastPollError.value = null
    try {
      const { runId } = await signalStatsApi.triggerRun(id)

      const poll = setInterval(async () => {
        try {
          const progress = await signalStatsApi.getRunProgress(id)
          runProgress.value.set(id, progress)

          if (progress.status === 'completed' || progress.status === 'failed') {
            clearInterval(poll)
            runningId.value = null
            // refresh runs list after completion
            await fetchRuns(id)
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

  async function fetchRuns(testId: string) {
    const data = await signalStatsApi.listRuns(testId)
    runsMap.value.set(testId, data)
    return data
  }

  async function fetchTrades(runId: string, page = 1, pageSize = 50) {
    const data = await signalStatsApi.listTrades(runId, page, pageSize)
    tradesMap.value.set(runId, data)
    return data
  }

  return {
    tests,
    runProgress,
    runningId,
    loading,
    lastPollError,
    runsMap,
    tradesMap,
    fetchTests,
    createTest,
    updateTest,
    deleteTest,
    startRun,
    fetchRuns,
    fetchTrades,
  }
})
