<template>
  <div class="run-progress">
    <!-- phase 已知：n-steps 步骤条 -->
    <template v-if="run.phase !== null">
      <p class="run-progress__title">{{ phaseTitle }}</p>
      <n-steps :current="stepIndex" size="small" class="run-progress__steps">
        <n-step title="扫描" />
        <n-step title="模拟" />
        <n-step title="写库" />
      </n-steps>
      <div class="run-progress__bar">
        <span class="run-progress__label">{{ phaseLabel }}</span>
        <n-progress
          type="line"
          :percentage="progressPct"
          :indicator-placement="'inside'"
          :processing="true"
          :color="'#2080f0'"
          :height="20"
        />
      </div>
    </template>

    <!-- phase === null：存量旧 run 降级为单进度条 -->
    <template v-else>
      <div class="run-progress__legacy">
        <n-progress
          type="line"
          :percentage="progressPct"
          :indicator-placement="'inside'"
          :color="'#2080f0'"
          :height="20"
        />
        <span class="run-progress__label">
          扫描中 {{ run.progressScanned }} / {{ run.progressTotal }}
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NProgress, NSteps, NStep } from 'naive-ui'
import type { SignalTestRun } from '../../api/modules/strategy/signalStats'

const props = defineProps<{
  run: SignalTestRun
}>()

/** 进度百分比（0-100 整数）。progressTotal=0 时返回 0。 */
const progressPct = computed(() => {
  if (props.run.progressTotal <= 0) return 0
  return Math.round((props.run.progressScanned / props.run.progressTotal) * 100)
})

/** n-steps :current（1-based）；null phase 分支不渲染 n-steps，此值不使用 */
const stepIndex = computed<number>(() => {
  switch (props.run.phase) {
    case 'scanning':   return 1
    case 'simulating': return 2
    case 'writing':    return 3
    default:           return 1
  }
})

/** 当前阶段标题 */
const phaseTitle = computed<string>(() => {
  switch (props.run.phase) {
    case 'scanning':   return '扫描交易日中…'
    case 'simulating': return '模拟出场中…'
    case 'writing':    return '写入结果中…'
    default:           return '运行中…'
  }
})

/** 当前阶段进度文案（done/total + 单位） */
const phaseLabel = computed<string>(() => {
  const scanned = props.run.progressScanned
  const total   = props.run.progressTotal
  switch (props.run.phase) {
    case 'scanning':   return `扫描交易日 ${scanned} / ${total}`
    case 'simulating': return `模拟出场 ${scanned} / ${total} 笔`
    case 'writing':    return `写入结果 ${scanned} / ${total} 行`
    default:           return `${scanned} / ${total}`
  }
})
</script>

<style scoped>
.run-progress {
  margin-bottom: 16px;
}

.run-progress__title {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--n-text-color-2, #666);
}

.run-progress__steps {
  margin-bottom: 12px;
}

.run-progress__bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-progress__label {
  font-size: 13px;
  color: var(--n-text-color-2, #666);
  white-space: nowrap;
}

.run-progress__legacy {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
