<template>
  <div class="summary-grid">
    <n-card v-for="item in items" :key="item.label" :bordered="false" class="summary-card">
      <div class="summary-label">{{ item.label }}</div>
      <div class="summary-value" :class="item.className">{{ item.value }}</div>
      <div class="summary-note">{{ item.note }}</div>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { NCard } from 'naive-ui'
import type { SummaryItem } from './types'

defineProps<{
  items: SummaryItem[]
}>()
</script>

<style scoped>
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-card :deep(.n-card__content) { padding: 16px; }
.summary-label { color: var(--color-text-secondary); font-size: 12px; margin-bottom: 8px; }
.summary-value { color: var(--color-text); font-size: 24px; font-weight: 700; line-height: 1.1; }
.summary-note { color: var(--color-text-muted); font-size: 12px; margin-top: 8px; }
.trend-up { color: var(--color-success); }
.trend-down { color: var(--color-error); }

@media (max-width: 960px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
