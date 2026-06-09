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
  const loading = ref(false)
  const lastPollError = ref<string | null>(null)

  // histogram keyed by runId
  const histogramMap = ref<Record<string, RetHistogramResult>>({})

  // --- 单轮询器状态（模块级，不导出） ---
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailures = 0
  const POLL_INTERVAL = 2000
  const MAX_CONSECUTIVE_FAILURES = 5

  const isRunning = (t: SignalTestWithLatestRun) => t.latestRun?.status === 'running'

  async function pollOnce() {
    const runningTests = tests.value.filter(isRunning)
    if (runningTests.length === 0) { stopPolling(); return }
    let anyFail = false
    for (const t of runningTests) {
      try {
        const run = await signalStatsApi.getRunProgress(t.id)
        patchLatestRun(t.id, run)
      } catch (err) {
        anyFail = true
        lastPollError.value = err instanceof Error ? err.message : '轮询进度失败'
        // 不 clearInterval：长 run 网络抖动不该永久断轮询，下一轮重试
      }
    }
    if (anyFail) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopPolling()
    } else {
      consecutiveFailures = 0
      lastPollError.value = null
    }
  }

  function ensurePolling() {
    if (pollTimer) return
    if (!tests.value.some(isRunning)) return
    consecutiveFailures = 0
    pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL)
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  /** 供 View 进页面调用：fetchTests 之后若有 running 就启轮询。 */
  function resumeAllPolling() { ensurePolling() }

  // --- CRUD ---

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
    lastPollError.value = null
    try {
      const { runId } = await signalStatsApi.triggerRun(id)
      // 立即拉一次 progress，让 latestRun 立刻变 running（按钮禁用+进度区即时显示），不等下一轮
      const run = await signalStatsApi.getRunProgress(id)
      patchLatestRun(id, run)
      ensurePolling()
      return { runId }
    } catch (err) {
      // 透传后端原始信息（如 409「该方案已有运行中的任务」），别统一吞成通用文案
      throw err instanceof Error ? err : new Error('启动运行失败')
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
    loading,
    lastPollError,
    histogramMap,
    fetchTests,
    createTest,
    updateTest,
    deleteTest,
    startRun,
    resumeAllPolling,
    stopPolling,
    fetchRetHistogram,
    fetchTrades,
  }
})
