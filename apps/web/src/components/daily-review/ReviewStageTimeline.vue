<template>
  <n-steps
    class="timeline"
    :current="currentIndex + 1"
    :status="failed ? 'error' : 'process'"
    size="small"
  >
    <n-step
      v-for="(s, i) in STAGES"
      :key="s"
      :title="STAGE_LABEL[s]"
      :description="durationFor(s) ?? (i === currentIndex && !done ? running : '')"
    />
  </n-steps>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NSteps, NStep } from 'naive-ui'
import type { Stage, StageTiming } from '@/types/daily-review'
import { STAGE_LABEL } from '@/types/daily-review'

const props = defineProps<{
  current: Stage
  timings: StageTiming[]
  done: boolean
  failed: boolean
}>()

// 阶段固定顺序——与 spec §5 Stage 定义保持一致
const STAGES: Stage[] = ['validate', 'fetch', 'build', 'reasoning', 'writing', 'finalize']

const currentIndex = computed(() => STAGES.indexOf(props.current))
const running = '进行中…'

function durationFor(s: Stage): string | null {
  const t = props.timings.find((x) => x.stage === s)
  if (!t) return null
  const sec = Math.max(1, Math.round(t.durationMs / 1000))
  return `${sec}s`
}
</script>

<style scoped>
.timeline { padding: 4px 0; }
.timeline :deep(.n-step-description) {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 2px;
}
</style>
