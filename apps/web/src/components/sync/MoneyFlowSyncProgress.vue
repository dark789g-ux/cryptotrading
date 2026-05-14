<template>
  <div v-if="visible" class="mfsp-panel">
    <div class="mfsp-head">
      <span>{{ headLabel }}</span>
      <span>{{ Math.round(sse.percent.value) }}%</span>
    </div>
    <n-progress
      type="line"
      :percentage="Math.round(sse.percent.value)"
      :status="progressStatus"
      indicator-placement="inside"
    />
    <div class="mfsp-meta">
      <span>{{ countLabel }}</span>
      <span>{{ sse.message.value }}</span>
    </div>

    <div v-if="finished" class="mfsp-summary">
      <div class="mfsp-summary-row">
        <span v-for="item in summaryRows" :key="item.label" class="mfsp-summary-item">
          {{ item.label }}：写入 {{ item.success }} / 跳过 {{ item.skipped }} / 失败 {{ item.failed }}
        </span>
      </div>
      <n-collapse v-if="finished.errors.length" class="mfsp-errors">
        <n-collapse-item :title="`失败明细（${finished.errors.length} 条）`" name="errors">
          <ul class="mfsp-error-list">
            <li v-for="(e, idx) in finished.errors.slice(0, 10)" :key="idx">
              [{{ e.phase }}] {{ e.error }}
            </li>
            <li v-if="finished.errors.length > 10" class="mfsp-error-more">
              还有 {{ finished.errors.length - 10 }} 条…
            </li>
          </ul>
        </n-collapse-item>
      </n-collapse>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem, NProgress } from 'naive-ui'
import type { useSSE } from '@/composables/hooks/useSSE'
import type { MoneyFlowSyncSummary } from '@/api/modules/market/moneyFlow'

const props = defineProps<{
  visible: boolean
  sse: ReturnType<typeof useSSE>
  finished: { summary: MoneyFlowSyncSummary; errors: Array<{ phase: string; error: string }> } | null
}>()

const headLabel = computed(() => {
  if (props.finished) return '同步完成'
  return props.sse.phase.value || '准备中'
})

const progressStatus = computed(() => {
  if (props.sse.status.value === 'error') return 'error'
  if (props.finished) return 'success'
  return 'default'
})

const countLabel = computed(() => {
  const c = props.sse.current.value
  const t = props.sse.total.value
  if (!t) return ''
  return `${c} / ${t}`
})

const summaryRows = computed(() => {
  if (!props.finished) return []
  const labels: Array<[keyof MoneyFlowSyncSummary, string]> = [
    ['stocks', '个股'],
    ['industries', '行业'],
    ['sectors', '板块'],
    ['market', '大盘'],
  ]
  return labels.map(([key, label]) => {
    const r = props.finished!.summary[key]
    return {
      label,
      success: r?.success ?? 0,
      skipped: r?.skipped ?? 0,
      failed: r?.errors.length ?? 0,
    }
  })
})
</script>

<style scoped>
.mfsp-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
.mfsp-head, .mfsp-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-text-secondary); font-size: 12px; }
.mfsp-head { color: var(--color-text); font-weight: 700; }
.mfsp-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mfsp-summary { margin-top: 4px; padding-top: 10px; border-top: 1px dashed var(--color-border); display: flex; flex-direction: column; gap: 8px; }
.mfsp-summary-row { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--color-text); }
.mfsp-summary-item { padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--color-primary) 8%, var(--color-surface)); }
.mfsp-errors { margin-top: 4px; }
.mfsp-error-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--color-text-secondary); line-height: 1.6; }
.mfsp-error-more { color: var(--color-text-tertiary); font-style: italic; list-style: none; padding-left: 0; }
</style>
