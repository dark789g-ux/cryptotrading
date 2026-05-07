<template>
  <div class="flow-bar-chart">
    <div v-if="!rows.length" class="empty">暂无数据</div>
    <div v-for="row in displayRows" :key="row.label" class="bar-row">
      <div class="bar-label" :title="row.label">{{ row.label }}</div>
      <div class="bar-track">
        <div
          class="bar-fill"
          :class="row.value >= 0 ? 'positive' : 'negative'"
          :style="{ width: barWidth(row.value) }"
        />
      </div>
      <div class="bar-value" :class="row.value >= 0 ? 'positive' : 'negative'">
        {{ formatAmount(row.value) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { BarChartRow } from './money-flow.types'

const props = defineProps<{
  rows: BarChartRow[]
  maxRows?: number
}>()

const displayRows = computed(() => {
  const sorted = [...props.rows].sort((a, b) => b.value - a.value)
  return props.maxRows ? sorted.slice(0, props.maxRows) : sorted
})

const maxAbs = computed(() => Math.max(...displayRows.value.map(r => Math.abs(r.value)), 1))

function barWidth(v: number): string {
  return `${Math.round((Math.abs(v) / maxAbs.value) * 100)}%`
}

function formatAmount(v: number): string {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}亿`
  return `${v.toFixed(2)}万`
}
</script>

<style scoped>
.flow-bar-chart { display: flex; flex-direction: column; gap: 6px; }
.empty { color: var(--color-text-muted); text-align: center; padding: 40px 0; }
.bar-row { display: grid; grid-template-columns: 100px 1fr 80px; align-items: center; gap: 8px; }
.bar-label { font-size: 12px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 14px; background: color-mix(in srgb, var(--color-border) 50%, transparent); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.bar-fill.positive { background: #f04747; }
.bar-fill.negative { background: #4caf8a; }
.bar-value { font-size: 12px; text-align: right; }
.bar-value.positive { color: #f04747; }
.bar-value.negative { color: #4caf8a; }
</style>
