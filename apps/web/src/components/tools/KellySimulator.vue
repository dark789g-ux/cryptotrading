<template>
  <div class="simulator">
    <KellyParamPanel :params="params" :is-simulating="isSimulating" @run="runSimulation" />

    <div class="simulator-main">
      <!-- 顶部诊断栏 -->
      <div class="diagnosis-bar">
        <div class="diagnosis-item">
          <span class="diagnosis-icon">🩺</span>
          <span class="diagnosis-label">当前诊断：</span>
          <span class="diagnosis-value" :class="kellyFull > 0 ? 'pos' : 'neg'">
            数学期望 {{ kellyFull > 0 ? '+' : '' }}{{ (kellyFull * params.rewardRisk).toFixed(3) }} R
          </span>
        </div>
        <div class="diagnosis-desc">
          核心基石：用<b>凯利公式</b>寻找理论资金增长极限，用海量<b>蒙特卡洛平行宇宙</b>抹平短期运气暴露长期宿命。
        </div>
        <div v-if="kellyFull > 0" class="diagnosis-badge gold">
          🔥 黄金系统：极佳的优势区间！使用精细化微仓能让你获得平滑复利。
        </div>
      </div>

      <!-- 负凯利警告 -->
      <div v-if="kellyFull <= 0" class="warn-bar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
          <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        凯利值为负或零（当前参数无正期望），建议不入场。
      </div>

      <!-- 逆向推算 -->
      <div class="reverse-bar">
        <div class="reverse-title">🎯 逆向推算单笔风险（基于收益/回撤目标与年均笔数）</div>
        <div class="reverse-body">
          <div class="reverse-constraints">
            <div class="constraint">
              • 达到 {{ params.targetReturn }}% 收益，单笔风险需 ≥ {{ reverseRisk.minRiskForReturn.toFixed(2) }}%
            </div>
            <div class="constraint">
              • 回撤控制在 {{ params.maxDrawdown }}% 内，单笔风险需 ≤ {{ reverseRisk.maxRiskForDD.toFixed(2) }}%
            </div>
          </div>
          <div class="reverse-recommend">
            <div class="rec-badge">
              <span class="rec-label">建议风险敞口</span>
              <span class="rec-value">满: {{ reverseRisk.recommendedFull.toFixed(2) }}%</span>
              <span class="rec-value">半: {{ reverseRisk.recommendedHalf.toFixed(2) }}%</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 四档结果卡片 -->
      <KellyResultCards :risk-levels="riskLevels" />

      <KellyMonteCarloCharts
        :paths="paths"
        :distribution="distribution"
        :initial-capital="params.initialCapital"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useKellySimulation } from './useKellySimulation'
import KellyParamPanel from './KellyParamPanel.vue'
import KellyResultCards from './KellyResultCards.vue'
import KellyMonteCarloCharts from './KellyMonteCarloCharts.vue'

const { params, kellyFull, riskLevels, reverseRisk, paths, distribution, isSimulating, runSimulation } = useKellySimulation()

// 参数变化时自动触发（debounce 在 Phase 2 加入）
watch(() => ({ ...params }), () => {
  runSimulation()
}, { deep: true })

// 初始执行
runSimulation()
</script>

<style scoped>
.simulator {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.simulator-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.diagnosis-bar {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.diagnosis-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}
.diagnosis-label { color: var(--color-text-secondary); }
.diagnosis-value.pos { color: var(--color-success); font-weight: 700; }
.diagnosis-value.neg { color: var(--color-error); font-weight: 700; }
.diagnosis-desc {
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.diagnosis-desc b { color: var(--color-text-secondary); }
.diagnosis-badge {
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 4px;
}
.diagnosis-badge.gold {
  background: color-mix(in srgb, #f0a020 10%, transparent);
  color: #f0a020;
}
.warn-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-error) 35%, transparent);
  border-radius: 8px;
  color: var(--color-error);
  font-size: 13px;
}
.reverse-bar {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.reverse-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
.reverse-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.reverse-constraints {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.reverse-recommend {
  flex-shrink: 0;
}
.rec-badge {
  background: color-mix(in srgb, var(--color-success) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rec-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-success);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rec-value {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
@media (max-width: 1200px) {
  .simulator { flex-direction: column; }
  .param-panel { width: 100%; }
}
</style>
