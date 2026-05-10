<template>
  <div class="flow-kpi-row">
    <div v-for="card in cards" :key="card.label" class="flow-kpi-card">
      <div class="kpi-label">{{ card.label }}</div>
      <div class="kpi-value" :class="valueClass(card.value)">
        <n-skeleton v-if="loading" text :width="80" />
        <template v-else>{{ formatValue(card.value, card.format) }}</template>
      </div>
      <div v-if="card.sub" class="kpi-sub">{{ card.sub }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NSkeleton } from 'naive-ui'
import type { KpiCardItem } from './money-flow.types'

const props = defineProps<{ cards: KpiCardItem[]; loading?: boolean }>()

function formatValue(v: string | null | undefined, format?: 'amount' | 'percent' | 'count'): string {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (isNaN(n)) return v
  if (format === 'count') return String(Math.round(n))
  if (format === 'percent') return `${n.toFixed(2)}%`
  return `${n.toFixed(2)}亿`
}

function valueClass(v: string | null | undefined) {
  const n = Number(v)
  if (isNaN(n) || v == null) return ''
  return n > 0 ? 'positive' : n < 0 ? 'negative' : ''
}
</script>

<style scoped>
.flow-kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.flow-kpi-card {
  background: var(--color-surface, #1e2028);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 14px 16px;
}
.kpi-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.kpi-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}
.kpi-value.positive { color: #f04747; }
.kpi-value.negative { color: #4caf8a; }
.kpi-sub {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 4px;
}
</style>
