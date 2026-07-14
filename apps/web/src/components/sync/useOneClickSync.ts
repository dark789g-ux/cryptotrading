import { computed, ref } from 'vue'
import { useOneClickSyncStore } from '@/stores/oneClickSync'
import { formatUTCDateTime } from '@/components/symbols/a-shares/aSharesFormatters'
import {
  STEP_KEYS,
  STEP_LABELS,
  toYYYYMMDD,
  type LogEntry,
  type OneClickErrorItem,
  type OneClickMessageApi,
  type OneClickStepKey,
  type OneClickStepStatus,
  type OneClickStepState,
  type OneClickSummary,
} from './oneClickSync.types'
import { useSyncStepPreferences } from './useSyncStepPreferences'
import { useMonotonicSteps } from './useMonotonicSteps'

export type {
  LogEntry,
  OneClickErrorItem,
  OneClickStepKey,
  OneClickStepStatus,
  OneClickStepState,
  OneClickSummary,
} from './oneClickSync.types'

/**
 * 后端持久化的 step 对象不带 label（其 OneClickStepState 无此字段，见
 * apps/server/.../one-click-sync/types.ts），而前端类型/模板按带 label 渲染步骤名。
 * 适配层在此按 step key 用静态 STEP_LABELS 补全，否则步骤行/summary 只显示「1.」无名字。
 */
function withLabel(s: OneClickStepState): OneClickStepState {
  return { ...s, label: STEP_LABELS[s.step] ?? '' }
}

/**
 * useOneClickSync —— 「一键同步」面板控制器（后端托管改造后的瘦身版）。
 *
 * 编排已搬到后端进程内（spec §4），本 composable 退化成「视图适配层」：
 *   - 状态全部读自 oneClickSync store（currentRun 轮询自后端 DB）；
 *   - start() 把 n-date-picker 的本地午夜 ms 用本地 TZ 转 YYYYMMDD 后调 store.startRun()；
 *   - cancel() 调 store.cancelRun()。
 * 不再持有 10 步编排链 / SSE 订阅 / 本地计时器 / 底层 sync composable 实例（全删）。
 * dateRange 仍是组件本地状态（日期选择器输入，未提交前不进 store）。
 */
export function useOneClickSync(message: OneClickMessageApi) {
  const store = useOneClickSyncStore()

  // 日期选择器输入（本地午夜 ms），仅 start() 时转 YYYYMMDD 提交，不进 store
  const dateRange = ref<[number, number] | null>(null)

  // 覆盖模式（默认 incremental）。
  // 仅 start() 时进请求体，不进 store（store/run entity 不持久化两者）。
  const syncMode = ref<'incremental' | 'overwrite'>('incremental')

  const {
    selectedStepKeys,
    allStepKeys,
    loadPreference,
    savePreference,
    toggleStep,
  } = useSyncStepPreferences({ scope: 'ashare', allKeys: STEP_KEYS })

  void loadPreference()

  // ---- 直接透传 store getter（形状与旧实现一致，Panel 模板不动）----
  const running = computed(() => store.running)
  const starting = computed(() => store.starting)
  const cancelling = computed(() => store.cancelling)

  // F1: 进度单调化 — 先 withLabel 再过 useMonotonicSteps，消除阶段切换的进度回退
  const rawSteps = computed<OneClickStepState[]>(() => store.steps.map(withLabel))
  const runId = computed(() => store.currentRun?.id)
  const steps = useMonotonicSteps(runId, rawSteps)

  const totalPercent = computed(() => store.totalPercent)
  const logEntries = computed<LogEntry[]>(() => store.logs)
  const currentStepIndex = computed(() => store.currentStepIndex)
  const elapsedMs = computed(() => store.elapsedMs)

  const canStart = computed(
    () => !running.value && !starting.value && !!dateRange.value && !!dateRange.value[0] && !!dateRange.value[1],
  )

  // ---- summary：由终态 currentRun 派生（旧实现是 start() 结束时一次性构建）----
  const summary = computed<OneClickSummary | null>(() => {
    const run = store.currentRun
    if (!run || run.status === 'running') return null
    const allErrors: OneClickErrorItem[] = []
    for (const s of run.steps) allErrors.push(...s.errors)
    return {
      steps: run.steps.map(s => ({ ...withLabel(s), errors: [...s.errors] })),
      totalMs: store.elapsedMs,
      errors: allErrors,
      cancelled: run.status === 'cancelled',
    }
  })

  /** 最近一次 success 的 finishedAt 格式化文本（标题「最近成功」标签用）；无则 ''。 */
  const latestSyncText = computed(() => {
    const run = store.latestSuccessRun
    return run?.finishedAt ? formatUTCDateTime(run.finishedAt) : ''
  })

  // ---- 控制：start / cancel 仅转调 store ----
  async function start(): Promise<void> {
    if (running.value || starting.value) return
    if (!dateRange.value || !dateRange.value[0] || !dateRange.value[1]) {
      message.error('请先选择日期范围')
      return
    }
    const startDate = toYYYYMMDD(dateRange.value[0])
    const endDate = toYYYYMMDD(dateRange.value[1])
    try {
      await store.startRun({
        startDate,
        endDate,
        syncMode: syncMode.value,
        selectedSteps: selectedStepKeys.value,
      })
      savePreference()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '启动一键同步失败')
    }
  }

  async function cancel(): Promise<void> {
    try {
      await store.cancelRun()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '取消失败')
    }
  }

  return {
    dateRange,
    running,
    starting,
    cancelling,
    steps,
    currentStepIndex,
    elapsedMs,
    logEntries,
    summary,
    latestSyncText,
    totalPercent,
    canStart,
    syncMode,
    selectedStepKeys,
    allStepKeys,
    toggleStep,
    start,
    cancel,
  }
}
