<template>
  <div class="progress-line">
    <div class="progress-meta">
      <span class="stage">{{ stage || '—' }}</span>
      <span class="percent">{{ percent }}%</span>
    </div>
    <n-progress
      type="line"
      :percentage="percent"
      :status="status"
      :indicator-placement="indicatorPlacement"
      :show-indicator="false"
      :height="8"
      :border-radius="4"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NProgress } from 'naive-ui'

/**
 * 训练进度条
 * - M3 阶段为静态展示（接受外部 progress / stage props）
 * - M4 才接 SSE 订阅；那时改为内部维护 EventSource，不破坏对外接口
 */
const props = withDefaults(
  defineProps<{
    /** 0..100 */
    progress: number
    stage?: string | null
    state?: 'pending' | 'running' | 'success' | 'failed' | 'blocked' | 'cancelled'
    indicatorPlacement?: 'inside' | 'outside'
  }>(),
  {
    stage: null,
    state: 'running',
    indicatorPlacement: 'outside',
  },
)

const percent = computed(() => {
  const v = Number(props.progress)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
})

const status = computed<'default' | 'success' | 'error' | 'warning' | 'info'>(() => {
  switch (props.state) {
    case 'success': return 'success'
    case 'failed': return 'error'
    case 'blocked': return 'warning'
    case 'cancelled': return 'warning'
    case 'pending': return 'info'
    default: return 'default'
  }
})
</script>

<style scoped>
.progress-line {
  width: 100%;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 4px;
}
.stage {
  color: var(--color-text-secondary);
  font-weight: 500;
}
.percent {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
