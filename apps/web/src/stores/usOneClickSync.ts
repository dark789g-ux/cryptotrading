/**
 * usOneClickSync store —— 「美股一键同步」前端「观察者」（镜像 A 股 oneClickSync store）。
 *
 * 与 A 股的区别：数据源是 **ml.jobs 行**（run_type='us_one_click_sync'），逐步骤进度态写在
 * job 行的 `resultPayload`（spec 01「result_payload 步骤态 schema」）。前端退化成纯「读」：
 * 点开始 → POST /api/us-stocks/one-click-sync 入队 1 条 job → 模块级 setInterval(2s) 轮询
 * GET /api/quant/jobs/:id 刷 currentJob；终态(success/failed/cancelled)自动停轮询；网络抖动不
 * 立刻断（连续 5 次失败才停）。进页面 onMounted 调 fetchActive() 恢复，running 则 resumePolling()。
 *
 * 状态全在 store（导航不销毁 store），组件重挂直接读 store —— 不需要 keep-alive。
 *
 * 注：result_payload 内的时间是 **epoch ms 数字**（worker 写入时刻，spec 01），与 A 股 store 的
 * UTC 墙钟字符串不同——这里直接做数字减法，不走 utcWallClockToMs。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  startUsOneClickSync,
  type UsOneClickSyncBody,
} from '../api/modules/market/usStocks'
import { quantApi } from '../api/modules/quant'
import type { JobRow, JobStatus } from '../api/modules/quant'
import {
  buildInitialUsSteps,
  US_STEP_LABELS,
  type LogEntry,
  type OneClickStepState,
  type OneClickSummary,
} from '../components/sync/oneClickSync.types'

/** job 行终态（轮询读到即停）。 */
const TERMINAL_STATUSES: ReadonlyArray<JobStatus> = ['success', 'failed', 'cancelled']

function isTerminal(job: JobRow | null): boolean {
  return !!job && TERMINAL_STATUSES.includes(job.status)
}

/** 安全把 resultPayload 里的字段读成数组（缺失/类型不符返回 []）。 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** 安全读 epoch ms 数字（非有限数返回 null）。 */
function asMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 后端 step 不带 label（result_payload schema 无此字段）；按 key 用 US_STEP_LABELS 补全。 */
function withUsLabel(s: OneClickStepState): OneClickStepState {
  return { ...s, label: US_STEP_LABELS[s.step] ?? s.label ?? '' }
}

export const useUsOneClickSyncStore = defineStore('usOneClickSync', () => {
  const currentJob = ref<JobRow | null>(null)
  const latestSuccessJob = ref<JobRow | null>(null)
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

  /** 当前 job 的 result_payload（可能为 {}）。 */
  const payload = computed<Record<string, unknown>>(
    () => currentJob.value?.resultPayload ?? {},
  )

  // --- getters（供 Panel 渲染，形状与 A 股 store 一致）---
  const running = computed(() => currentJob.value?.status === 'running')

  /**
   * steps：从 resultPayload.steps 映射并补 label；payload 为空/缺 steps（job 刚建、worker 未写）
   * → 兜底「3 步 pending」初始态，避免渲染空白。
   */
  const steps = computed<OneClickStepState[]>(() => {
    const raw = asArray<OneClickStepState>(payload.value.steps)
    if (raw.length === 0) return buildInitialUsSteps()
    return raw.map(withUsLabel)
  })

  // 后端已算总进度，直接用 job.progress（0-100）
  const totalPercent = computed(() => currentJob.value?.progress ?? 0)

  const logs = computed<LogEntry[]>(() => asArray<LogEntry>(payload.value.logs))

  /** 当前步索引：取第一个 running 的步；无则取最后一个非 pending 的步；兜底 -1。 */
  const currentStepIndex = computed(() => {
    const list = steps.value
    const runningIdx = list.findIndex(s => s.status === 'running')
    if (runningIdx >= 0) return runningIdx
    let lastActive = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i].status !== 'pending') lastActive = i
    }
    return lastActive
  })

  /** elapsedMs：由 resultPayload.startedAt（epoch ms）派生；running 跟 nowTick，终态停在 finishedAt。 */
  const elapsedMs = computed(() => {
    const startMs = asMs(payload.value.startedAt)
    if (startMs === null) return 0
    const finishedMs = asMs(payload.value.finishedAt)
    const endMs = finishedMs ?? (isTerminal(currentJob.value) ? startMs : nowTick.value)
    return Math.max(0, endMs - startMs)
  })

  /** summary：终态时由 resultPayload 派生 OneClickSummary（running 时为 null）。 */
  const summary = computed<OneClickSummary | null>(() => {
    const job = currentJob.value
    if (!job || job.status === 'running' || job.status === 'pending' || job.status === 'draft') {
      return null
    }
    const stepList = steps.value
    const allErrors = stepList.flatMap(s => s.errors ?? [])
    return {
      steps: stepList.map(s => ({ ...s, errors: [...(s.errors ?? [])] })),
      totalMs: elapsedMs.value,
      errors: allErrors,
      cancelled: job.status === 'cancelled' || payload.value.cancelled === true,
    }
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
    nowTick.value = Date.now()
  }

  async function pollOnce() {
    const job = currentJob.value
    if (!job || job.status !== 'running') {
      stopPolling()
      return
    }
    try {
      const next = await quantApi.getJob(job.id)
      currentJob.value = next
      consecutiveFailures = 0
      lastPollError.value = null
      if (isTerminal(next)) {
        stopPolling()
        if (next.status === 'success') void fetchLatestSuccess()
      }
    } catch (err) {
      lastPollError.value = err instanceof Error ? err.message : '轮询进度失败'
      // 不立刻 clear：长 run 网络抖动不该永久断轮询，下一轮重试
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopPolling()
    }
  }

  function ensurePolling() {
    if (currentJob.value?.status !== 'running') return
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
  function resumePolling() {
    if (currentJob.value?.status === 'running') ensurePolling()
  }

  // --- actions ---

  /** 开始美股一键同步：POST /one-click-sync → 拿 jobId → getJob 取完整行 → set currentJob → 启轮询。 */
  async function startRun(body: { startDate: string; endDate: string }) {
    lastPollError.value = null
    try {
      const reqBody: UsOneClickSyncBody = {
        dateRange: [body.startDate, body.endDate],
      }
      const { jobId } = await startUsOneClickSync(reqBody)
      const job = await quantApi.getJob(jobId)
      currentJob.value = job
      nowTick.value = Date.now()
      ensurePolling()
      return job
    } catch (err) {
      // 透传后端原始信息（如 400 日期非法），不吞成通用文案
      throw err instanceof Error ? err : new Error('启动美股一键同步失败')
    }
  }

  /** 进页面恢复：GET /quant/jobs?run_type=us_one_click_sync&page_size=1 → items[0]（可能为 null）。 */
  async function fetchActive() {
    const page = await quantApi.listJobs({
      run_type: ['us_one_click_sync'],
      page: 1,
      pageSize: 1,
    })
    currentJob.value = page.rows[0] ?? null
    nowTick.value = Date.now()
    return currentJob.value
  }

  /** 拉最近一次 success 的 job（标题「最近成功」标签用）。失败静默保持原值。 */
  async function fetchLatestSuccess() {
    try {
      const page = await quantApi.listJobs({
        run_type: ['us_one_click_sync'], status: ['success'], page: 1, pageSize: 1,
      })
      latestSuccessJob.value = page.rows[0] ?? null
    } catch { /* 静默 */ }
  }

  /** 取消：currentJob 存在则 POST /quant/jobs/:id/cancel（置 cancel_requested，worker 异步响应）。 */
  async function cancelRun() {
    const job = currentJob.value
    if (!job) return
    await quantApi.cancelJob(job.id)
  }

  return {
    // state
    currentJob,
    latestSuccessJob,
    lastPollError,
    // getters
    running,
    steps,
    totalPercent,
    logs,
    currentStepIndex,
    elapsedMs,
    summary,
    // actions
    startRun,
    fetchActive,
    fetchLatestSuccess,
    cancelRun,
    ensurePolling,
    resumePolling,
    stopPolling,
  }
})
