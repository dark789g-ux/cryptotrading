<template>
  <div class="summary-cards">
    <div v-for="item in cards" :key="item.label" class="summary-card">
      <div class="summary-card-label">{{ item.label }}</div>
      <div class="summary-card-value" :class="item.cls">{{ item.value }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RegimeBacktestRun } from '@/api/modules/strategy/regimeEngine'

const props = defineProps<{
  run: RegimeBacktestRun
}>()

interface CardItem {
  label: string
  value: string
  cls: string
}

function fmtPct(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return `${(val * 100).toFixed(2)}%`
}

function fmtNum(val: number | null, digits = 2): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return val.toFixed(digits)
}

function pctCls(val: number | null): string {
  if (val == null) return ''
  return val > 0 ? 'trend-up' : val < 0 ? 'trend-down' : ''
}

const cards = computed<CardItem[]>(() => {
  const r = props.run
  return [
    { label: '最终净值', value: fmtNum(r.finalNav), cls: '' },
    { label: '总收益', value: fmtPct(r.totalRet), cls: pctCls(r.totalRet) },
    { label: '年化收益', value: fmtPct(r.annualRet), cls: pctCls(r.annualRet) },
    { label: '最大回撤', value: fmtPct(r.maxDrawdown), cls: 'trend-down' },
    { label: 'Sharpe', value: fmtNum(r.sharpe), cls: '' },
    { label: 'Calmar', value: fmtNum(r.calmar), cls: '' },
    { label: '成交笔数', value: String(r.nTaken ?? '-'), cls: '' },
    { label: '跳过笔数', value: String(r.nSkipped ?? '-'), cls: '' },
    { label: '总成本', value: fmtNum(r.totalCosts), cls: '' },
  ]
})
</script>

<style scoped>
.summary-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
}

.summary-card {
  background: color-mix(in srgb, var(--color-surface-elevated) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
  border-radius: 8px;
  padding: 10px 12px;
}

.summary-card-label {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.summary-card-value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.trend-up {
  color: var(--color-success);
}

.trend-down {
  color: var(--color-error);
}
</style>
