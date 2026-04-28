<template>
  <div v-if="riskLevels.length" class="result-cards">
    <div
      v-for="item in riskLevels"
      :key="item.label"
      class="result-card"
      :style="{ '--card-color': item.color }"
    >
      <div class="card-top">
        <div class="card-title-row">
          <span class="card-label">{{ item.label }}</span>
          <span class="card-tag">{{ item.tag }}</span>
        </div>
        <div class="card-risk">单笔 {{ item.singleRisk.toFixed(1) }}%</div>
      </div>
      <div class="card-body">
        <div class="metric">
          <span class="metric-label">中位数余额</span>
          <span class="metric-value" :style="{ color: item.color }">${{ item.medianBalance.toFixed(1) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">最大回撤(劣势20%)</span>
          <span class="metric-value" :class="item.maxDrawdown > 90 ? 'danger' : item.maxDrawdown > 70 ? 'warning' : ''">{{ item.maxDrawdown.toFixed(1) }}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">爆仓率(&lt;$10)</span>
          <span class="metric-value" :class="item.bustRate > 20 ? 'danger' : item.bustRate > 5 ? 'warning' : ''">{{ item.bustRate.toFixed(1) }}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">腰斩率(&lt;$50)</span>
          <span class="metric-value" :class="item.halvedRate > 30 ? 'danger' : item.halvedRate > 10 ? 'warning' : ''">{{ item.halvedRate.toFixed(1) }}%</span>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="empty-cards">
    <div class="empty-text">调整参数以查看风险模拟结果</div>
  </div>
</template>

<script setup lang="ts">
import type { RiskLevelResult } from './useKellySimulation'

defineProps<{
  riskLevels: RiskLevelResult[]
}>()
</script>

<style scoped>
.result-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.result-card {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
  border-top: 3px solid var(--card-color);
}
.card-top {
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.card-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
.card-tag {
  font-size: 11px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
}
.card-risk {
  font-size: 13px;
  font-weight: 600;
  color: var(--card-color);
}
.card-body {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.metric {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.metric-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
.metric-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
}
.metric-value.warning { color: #f0a020; }
.metric-value.danger { color: #d03050; }

.empty-cards {
  background: var(--color-surface-elevated);
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  padding: 40px;
  text-align: center;
  color: var(--color-text-muted);
}
.empty-text {
  font-size: 14px;
}

@media (max-width: 1200px) {
  .result-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .result-cards {
    grid-template-columns: 1fr;
  }
}
</style>
