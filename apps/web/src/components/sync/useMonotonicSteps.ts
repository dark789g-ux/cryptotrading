import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'
import type { OneClickStepState } from './oneClickSync.types'

/**
 * 进度单调化:running 步骤的 percent 在一次 run 内只升不降,
 * 消除 base-data(stk_limit→suspend_d) / sw(目录→行情)阶段切换的视觉回退。
 * 非 running 态(success/failed/skipped/pending)透传原值。
 */
export function useMonotonicSteps(
  runIdRef: Ref<string | null | undefined>,
  rawStepsRef: ComputedRef<OneClickStepState[]>,
): ComputedRef<OneClickStepState[]> {
  const maxPct = reactive<Record<string, number>>({})

  // 新 run 重置(含首次 null→id)
  watch(runIdRef, () => {
    for (const k of Object.keys(maxPct)) delete maxPct[k]
  })

  // running 态累积 max
  watch(rawStepsRef, (steps) => {
    for (const s of steps) {
      if (s.status === 'running') {
        maxPct[s.step] = Math.max(maxPct[s.step] ?? 0, s.percent)
      }
    }
  }, { deep: true })

  return computed(() =>
    rawStepsRef.value.map((s) =>
      s.status === 'running' && (maxPct[s.step] ?? 0) > s.percent
        ? { ...s, percent: maxPct[s.step] }
        : s,
    ),
  )
}
