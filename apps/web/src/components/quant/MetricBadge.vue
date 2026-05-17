<template>
  <n-tag :type="tone" round size="small" class="metric-badge">
    <span class="label">{{ label }}</span>
    <span class="value">{{ display }}</span>
  </n-tag>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'

type Tone = 'default' | 'success' | 'warning' | 'error' | 'info'

const props = withDefaults(
  defineProps<{
    label: string
    value: number | null | undefined
    /**
     * 数值阈值，超过/低于触发颜色映射。
     * 默认按 0 划分：>= warn 绿，>= 0 黄，< 0 红。
     */
    thresholds?: { good?: number; warn?: number }
    /** 数值是否按百分比展示 */
    percent?: boolean
    /** 小数位数 */
    digits?: number
    /** 反向：越小越好（如波动率） */
    inverse?: boolean
  }>(),
  {
    thresholds: () => ({ good: 0.05, warn: 0 }),
    percent: false,
    digits: 4,
  },
)

const display = computed(() => {
  if (props.value === null || props.value === undefined || Number.isNaN(props.value)) {
    return '—'
  }
  const v = props.value
  if (props.percent) {
    return `${(v * 100).toFixed(Math.min(props.digits, 2))}%`
  }
  return v.toFixed(props.digits)
})

const tone = computed<Tone>(() => {
  if (props.value === null || props.value === undefined || Number.isNaN(props.value)) {
    return 'default'
  }
  const good = props.thresholds.good ?? 0.05
  const warn = props.thresholds.warn ?? 0
  const v = props.inverse ? -props.value : props.value
  const g = props.inverse ? -good : good
  const w = props.inverse ? -warn : warn
  if (props.inverse) {
    if (v <= g) return 'success'
    if (v <= w) return 'warning'
    return 'error'
  }
  if (v >= g) return 'success'
  if (v >= w) return 'warning'
  return 'error'
})
</script>

<style scoped>
.metric-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 24px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.label {
  color: var(--color-text-muted);
  font-weight: 500;
}
.value {
  font-weight: 700;
}
</style>
