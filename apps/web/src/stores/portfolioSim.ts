/**
 * portfolioSim store —— 组合级模拟器列表 + 单全局轮询器（照搬 signalStats store）。
 *
 * 轮询模型：模块级单 setInterval，每 2s 把所有 status==='running' 的行拉一次 progress 补丁回去；
 * 全部终态 → stopPolling；网络抖动不立刻断（连续 5 次失败才停）。无前端超时。
 * 进入页面 onMounted 调 resumeAllPolling()，刷新后若有 running 自动恢复轮询。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { portfolioSimApi } from '../api/modules/strategy/portfolioSim'
import type {
  PortfolioSimRun,
  PortfolioSimProgress,
  CreatePortfolioSimDto,
} from '../api/modules/strategy/portfolioSim'

export const usePortfolioSimStore = defineStore('portfolioSim', () => {
  const runs = ref<PortfolioSimRun[]>([])
  const loading = ref(false)
  const lastPollError = ref<string | null>(null)

  // --- 单轮询器状态（模块级，不导出）---
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailures = 0
  const POLL_INTERVAL = 2000
  const MAX_CONSECUTIVE_FAILURES = 5

  const isRunning = (r: PortfolioSimRun) => r.status === 'running'

  /** 把 progress 补丁合并进对应 run（保留终态指标字段，仅覆盖进度相关）。 */
  function patchProgress(id: string, p: PortfolioSimProgress) {
    const r = runs.value.find((x) => x.id === id)
    if (!r) return
    r.status = p.status
    r.phase = p.phase
    r.progressDone = p.progressDone
    r.progressTotal = p.progressTotal
    r.errorMessage = p.errorMessage
  }

  async function pollOnce() {
    const running = runs.value.filter(isRunning)
    if (running.length === 0) {
      stopPolling()
      return
    }
    let anyFail = false
    let anyFinished = false
    for (const r of running) {
      try {
        const p = await portfolioSimApi.getProgress(r.id)
        patchProgress(r.id, p)
        if (p.status !== 'running') anyFinished = true
      } catch (err) {
        anyFail = true
        lastPollError.value = err instanceof Error ? err.message : '轮询进度失败'
        // 不立刻 clear：长 run 网络抖动不该永久断轮询，下一轮重试
      }
    }
    // 有 run 刚转终态：拉一次全量详情，把指标/anchorCheck 等终态字段补齐
    if (anyFinished) await refreshFinishedDetails()
    if (anyFail) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopPolling()
    } else {
      consecutiveFailures = 0
      lastPollError.value = null
    }
  }

  /** 终态 run 的精简 progress 不含指标，需补拉详情把 finalNav/annualRet/anchorCheck 等填上。 */
  async function refreshFinishedDetails() {
    const targets = runs.value.filter((r) => r.status !== 'running' && r.finalNav == null && r.status === 'success')
    for (const r of targets) {
      try {
        const full = await portfolioSimApi.findOne(r.id)
        const idx = runs.value.findIndex((x) => x.id === r.id)
        if (idx !== -1) runs.value[idx] = full
      } catch {
        // 详情补拉失败不致命，下次手动刷新可补
      }
    }
  }

  function ensurePolling() {
    if (pollTimer) return
    if (!runs.value.some(isRunning)) return
    consecutiveFailures = 0
    pollTimer = setInterval(() => {
      void pollOnce()
    }, POLL_INTERVAL)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** 供 View 进页面调用：fetchRuns 之后若有 running 就启轮询。 */
  function resumeAllPolling() {
    ensurePolling()
  }

  // --- CRUD ---

  async function fetchRuns() {
    loading.value = true
    try {
      const page = await portfolioSimApi.findAll(1, 200)
      runs.value = page.items
    } finally {
      loading.value = false
    }
  }

  async function createRun(dto: CreatePortfolioSimDto) {
    const data = await portfolioSimApi.create(dto)
    runs.value.unshift(data)
    return data
  }

  async function deleteRun(id: string) {
    await portfolioSimApi.remove(id)
    runs.value = runs.value.filter((r) => r.id !== id)
  }

  async function startRun(id: string) {
    lastPollError.value = null
    try {
      const res = await portfolioSimApi.triggerRun(id)
      // 立即拉一次 progress，让该行立刻变 running（按钮禁用 + 步骤条即时显示）
      const p = await portfolioSimApi.getProgress(id)
      patchProgress(id, p)
      ensurePolling()
      return res
    } catch (err) {
      // 透传后端原始信息（如 409「该组合模拟已有运行中的任务」/ 400 源 run 校验失败），不吞成通用文案
      throw err instanceof Error ? err : new Error('启动运行失败')
    }
  }

  /** 详情/重看时拉单条全量（含指标/anchorCheck），并就地刷新列表缓存。 */
  async function fetchOne(id: string) {
    const full = await portfolioSimApi.findOne(id)
    const idx = runs.value.findIndex((x) => x.id === id)
    if (idx !== -1) runs.value[idx] = full
    return full
  }

  return {
    runs,
    loading,
    lastPollError,
    fetchRuns,
    createRun,
    deleteRun,
    startRun,
    fetchOne,
    resumeAllPolling,
    stopPolling,
  }
})
