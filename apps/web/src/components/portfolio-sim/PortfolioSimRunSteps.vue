<template>
  <div class="run-steps">
    <n-steps :current="stepIndex" size="small" class="run-steps__steps">
      <n-step title="装载" />
      <n-step title="回放" />
      <n-step title="写库" />
    </n-steps>
    <div class="run-steps__bar">
      <span class="run-steps__label">{{ phaseLabel }}</span>
      <n-progress
        type="line"
        :percentage="progressPct"
        :indicator-placement="'inside'"
        :processing="true"
        :color="'#2080f0'"
        :height="18"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NProgress, NSteps, NStep } from 'naive-ui'
import type {
  PortfolioSimPhase,
} from '../../api/modules/strategy/portfolioSim'

const props = defineProps<{
  phase: PortfolioSimPhase
  progressDone: number
  progressTotal: number
}>()

/** 进度百分比（0-100 整数）。total=0 时返回 0。 */
const progressPct = computed(() => {
  if (props.progressTotal <= 0) return 0
  return Math.round((props.progressDone / props.progressTotal) * 100)
})

/** n-steps :current（1-based）。phase=null 时停留在装载步。 */
const stepIndex = computed<number>(() => {
  switch (props.phase) {
    case 'loading':
      return 1
    case 'replaying':
      return 2
    case 'writing':
      return 3
    default:
      return 1
  }
})

/** 阶段进度文案（done/total + 单位）。 */
const phaseLabel = computed<string>(() => {
  const done = props.progressDone
  const total = props.progressTotal
  switch (props.phase) {
    case 'loading':
      return `装载源数据 ${done} / ${total}`
    case 'replaying':
      return `逐日回放 ${done} / ${total}`
    case 'writing':
      return `写入结果 ${done} / ${total} 行`
    default:
      return `准备中 ${done} / ${total}`
  }
})
</script>

<style scoped>
.run-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.run-steps__steps {
  margin-bottom: 4px;
}

.run-steps__bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-steps__label {
  font-size: 12px;
  color: var(--n-text-color-2, #666);
  white-space: nowrap;
}
</style>
