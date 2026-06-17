import { computed, ref } from 'vue'
import { useUsOneClickSyncStore } from '@/stores/usOneClickSync'
import {
  toYYYYMMDD,
  type LogEntry,
  type OneClickMessageApi,
  type OneClickPanelController,
  type OneClickStepState,
  type OneClickSummary,
} from './oneClickSync.types'

/**
 * useUsOneClickSync —— 「美股一键同步」面板控制器（与 A 股 useOneClickSync 实现同一接口
 * OneClickPanelController，喂给复用的 OneClickSyncPanel）。
 *
 * 瘦适配层：状态全部读自 usOneClickSync store（currentJob 轮询自 ml.jobs 的 resultPayload）：
 *   - dateRange 仍是组件本地状态（n-date-picker 本地午夜 ms，未提交前不进 store）；
 *   - start() 把本地午夜 ms 用本地 TZ 转 YYYYMMDD 后调 store.startRun()（遵守日期选择器本地 TZ 例外）；
 *   - cancel() 调 store.cancelRun()。
 * label 补全已在 store 的 steps/summary getter 内用 US_STEP_LABELS 完成，此处直接透传。
 */
export function useUsOneClickSync(message: OneClickMessageApi): OneClickPanelController {
  const store = useUsOneClickSyncStore()

  // 日期选择器输入（本地午夜 ms），无默认 = null；仅 start() 时转 YYYYMMDD 提交，不进 store
  const dateRange = ref<[number, number] | null>(null)

  // ---- 直接透传 store getter（形状与 A 股 controller 一致，Panel 模板不动）----
  const running = computed(() => store.running)
  const steps = computed<OneClickStepState[]>(() => store.steps)
  const totalPercent = computed(() => store.totalPercent)
  const logEntries = computed<LogEntry[]>(() => store.logs)
  const currentStepIndex = computed(() => store.currentStepIndex)
  const elapsedMs = computed(() => store.elapsedMs)
  const summary = computed<OneClickSummary | null>(() => store.summary)

  const canStart = computed(
    () => !running.value && !!dateRange.value && !!dateRange.value[0] && !!dateRange.value[1],
  )

  // ---- 控制：start / cancel 仅转调 store ----
  async function start(): Promise<void> {
    if (running.value) return
    if (!dateRange.value || !dateRange.value[0] || !dateRange.value[1]) {
      message.error('请先选择日期范围')
      return
    }
    const startDate = toYYYYMMDD(dateRange.value[0])
    const endDate = toYYYYMMDD(dateRange.value[1])
    try {
      await store.startRun({ startDate, endDate })
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '启动美股一键同步失败')
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
    steps,
    currentStepIndex,
    elapsedMs,
    logEntries,
    summary,
    totalPercent,
    canStart,
    start,
    cancel,
  }
}
