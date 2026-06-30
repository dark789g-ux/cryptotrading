<template>
  <n-card title="整体 OOS 指标" size="small" :bordered="false">
    <div class="grid">
      <div class="cell">
        <span class="label">NDCG@5</span>
        <MetricBadge label="" :value="ndcg5" :digits="4" :thresholds="{ good: 0.55, warn: 0.5 }" />
      </div>
      <div class="cell">
        <span class="label">NDCG@10</span>
        <MetricBadge label="" :value="ndcg10" :digits="4" :thresholds="{ good: 0.55, warn: 0.5 }" />
      </div>
      <div class="cell">
        <span class="label">IC</span>
        <MetricBadge label="" :value="ic" :digits="4" :thresholds="{ good: 0.05, warn: 0.02 }" />
      </div>
      <div class="cell">
        <span class="label">Rank IC</span>
        <MetricBadge label="" :value="rankIc" :digits="4" :thresholds="{ good: 0.05, warn: 0.02 }" />
      </div>
      <div class="cell">
        <span class="label">单笔净收益(中位)</span>
        <MetricBadge label="" :value="annual" :percent="true" :digits="2"
          :thresholds="{ good: 0.002, warn: 0 }" />
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCard } from 'naive-ui'
import MetricBadge from '@/components/quant/common/MetricBadge.vue'
import type { OosMetricsCore } from '@/api/modules/quant'

const props = defineProps<{
  core: OosMetricsCore
  /** oos_metrics 全量 jsonb；用于回退取 ndcg@5 等 core 未覆盖的指标 */
  metrics: Record<string, unknown>
}>()

function pickNum(...keys: string[]): number | null {
  for (const k of keys) {
    const v = props.metrics?.[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

const ndcg5 = computed(() =>
  props.core?.ndcg_at_5 ?? pickNum('ndcg_at_5', 'ndcg@5'),
)
const ndcg10 = computed(() =>
  props.core?.ndcg_at_10 ?? pickNum('ndcg_at_10', 'ndcg@10'),
)
const ic = computed(() => props.core?.ic ?? pickNum('ic'))
const rankIc = computed(() => props.core?.rank_ic ?? pickNum('rank_ic'))
const annual = computed(() =>
  props.core?.portfolio_annual_after_cost ?? pickNum('portfolio_annual_after_cost'),
)
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-elevated);
}
.label {
  font-size: 11px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
</style>
