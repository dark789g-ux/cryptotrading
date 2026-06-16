/**
 * oneClickSync store —— 「一键同步」后端托管编排的前端「观察者」（照搬 signalStats/portfolioSim 范式）。
 *
 * 编排在后端进程内跑（spec §4.2），前端退化成纯「读」：点开始 → POST 让后端跑 → 模块级单
 * setInterval(2s) 轮询 GET /runs/:id 把进度补丁回 currentRun；终态自动停轮询；网络抖动不立刻断
 * （连续 5 次失败才停）。进页面 onMounted 调 fetchActive() 恢复显示，running 则 resumeAllPolling()。
 *
 * 状态全在 store（导航不销毁 store），组件重挂直接读 store —— 不需要 keep-alive。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { oneClickSyncApi } from '../api/modules/market/one-click-sync'
import type {
  OneClickSyncRun,
  StartOneClickSyncDto,
} from '../api/modules/market/one-click-sync'

const TERMINAL_STATUSES: ReadonlyArray<OneClickSyncRun['status']> = [
  'success',
  'failed',
  'cancelled',
]

function isTerminal(run: OneClickSyncRun | null): boolean {
  return !!run && TERMINAL_STATUSES.includes(run.status)
}

/**
 * UTC 墙钟串 → epoch ms。后端 formatUtcWallClock 产 'YYYY-MM-DD HH:mm:ssZ'（**带尾 Z**）；
 * 转 ISO（空格→T）后：已带 Z 则不重复补（否则双 Z → Invalid Date），无 Z 才补 Z 当 UTC 解析
 * （无 Z 会被当本地时间，见 .claude/rules/datetime.md）。
 */
function utcWallClockToMs(s: string): number {
  const t = s.replace(' ', 'T')
  return new Date(t.endsWith('Z') ? t : `${t}Z`).getTime()
}

export const useOneClickSyncStore = defineStore('oneClickSync', () => {
  const currentRun = ref<OneClickSyncRun | null>(null)
  const lastPollError = ref<string | null>(null)

  // 250ms ticker 平滑显示耗时（仅 running 时跳动；终态停在最终值）
  const nowTick = ref(Date.now())

  // --- 单轮询器状态（模块级，不导出）---
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailures = 0
  const POLL_INTERVAL = 2000
  const ELAPSED_INTERVAL = 250
  const MAX_CONSECUTIVE_FAILURES = 5

  // --- getters（供 Panel 渲染，形状与旧 composable 一致）---
  const running = computed(() => currentRun.value?.status === 'running')
  const steps = computed(() => currentRun.value?.steps ?? [])
  // 后端已算总进度，直接用 progress（0-100）
  const totalPercent = computed(() => currentRun.value?.progress ?? 0)
  const logs = computed(() => currentRun.value?.logs ?? [])
  const currentStepIndex = computed(() => currentRun.value?.currentStep ?? -1)
  /** 由顶层 startedAt（UTC 墙钟串）派生：running 跟 nowTick 跳动，终态停在 finishedAt（无则 updatedAt）。 */
  const elapsedMs = computed(() => {
    const run = currentRun.value
    if (!run) return 0
    const startMs = utcWallClockToMs(run.startedAt)
    if (Number.isNaN(startMs)) return 0
    const endStr = run.finishedAt ?? (isTerminal(run) ? run.updatedAt : null)
    const endMs = endStr ? utcWallClockToMs(endStr) : nowTick.value
    return Math.max(0, endMs - startMs)
  })

  // --- 计时器 / 轮询器 ---
  function startElapsedTicker() {
    if (elapsedTimer) return
    elapsedTimer = setInterval(() => {
      nowTick.value = Date.now()
    }, ELAPSED_INTERVAL)
  }

  function stopElapsedTicker() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    // 终态把 nowTick 推到当前，让 elapsedMs 的 running 分支不会再用（已 isTerminal）
    nowTick.value = Date.now()
  }

  async function pollOnce() {
    const run = currentRun.value
    if (!run || run.status !== 'running') {
      stopPolling()
      return
    }
    try {
      const next = await oneClickSyncApi.getRun(run.id)
      currentRun.value = next
      consecutiveFailures = 0
      lastPollError.value = null
      if (isTerminal(next)) stopPolling()
    } catch (err) {
      lastPollError.value = err instanceof Error ? err.message : '轮询进度失败'
      // 不立刻 clear：长 run 网络抖动不该永久断轮询，下一轮重试
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopPolling()
    }
  }

  function ensurePolling() {
    if (currentRun.value?.status !== 'running') return
    startElapsedTicker()
    if (pollTimer) return
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
    stopElapsedTicker()
  }

  /** 供 View 进页面调用：fetchActive 之后若 running 就启轮询。 */
  function resumeAllPolling() {
    if (currentRun.value?.status === 'running') ensurePolling()
  }

  // --- actions ---

  /** 开始一键同步：POST /runs（单飞，后端命中 running 复用）→ set currentRun → 启轮询。 */
  async function startRun(dto: StartOneClickSyncDto) {
    lastPollError.value = null
    try {
      const run = await oneClickSyncApi.startRun(dto)
      currentRun.value = run
      nowTick.value = Date.now()
      ensurePolling()
      return run
    } catch (err) {
      // 透传后端原始信息（如 400 日期非法），不吞成通用文案
      throw err instanceof Error ? err : new Error('启动一键同步失败')
    }
  }

  /** 进页面恢复：GET /runs/active → set currentRun（可能为 null）。 */
  async function fetchActive() {
    const run = await oneClickSyncApi.getActive()
    currentRun.value = run
    nowTick.value = Date.now()
    return run
  }

  /** 取消：currentRun 存在则 POST /runs/:id/cancel → patch currentRun。 */
  async function cancelRun() {
    const run = currentRun.value
    if (!run) return
    const next = await oneClickSyncApi.cancelRun(run.id)
    currentRun.value = next
  }

  return {
    // state
    currentRun,
    lastPollError,
    // getters
    running,
    steps,
    totalPercent,
    logs,
    currentStepIndex,
    elapsedMs,
    // actions
    startRun,
    fetchActive,
    cancelRun,
    ensurePolling,
    resumeAllPolling,
    stopPolling,
  }
})
