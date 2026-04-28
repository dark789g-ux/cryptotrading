<template>
  <div class="param-panel" :class="{ collapsed: isCollapsed && isNarrow }">
    <div class="panel-header" @click="toggleCollapse">
      <div class="panel-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div>
        <div class="panel-title">凯利-蒙特卡洛模拟器</div>
        <div class="panel-desc">Kelly Criterion + Monte Carlo</div>
      </div>
      <span v-if="isNarrow" class="collapse-icon">{{ isCollapsed ? '▶' : '▼' }}</span>
    </div>

    <div v-show="!isCollapsed || !isNarrow" class="panel-body">
      <!-- 起始资金 -->
      <div class="field-group">
        <div class="field-label">起始资金 <span class="field-unit">$</span></div>
        <n-input-number v-model:value="params.initialCapital" :min="10" :max="1000000" :step="100" style="width:100%" />
      </div>

      <ParamSlider label="真实胜率" unit="%" v-model="params.winRate" :min="1" :max="99" :step="1" />
      <ParamSlider label="盈亏比" unit="R" v-model="params.rewardRisk" :min="0.1" :max="10" :step="0.1" />
      <ParamSlider label="单次模拟交易总笔数" unit="笔" v-model="params.tradesPerSim" :min="10" :max="1000" :step="10" />
      <ParamSlider label="平行宇宙数量" unit="个" v-model="params.universes" :min="100" :max="5000" :step="100" />
      <ParamSlider label="目标年化收益" unit="%" v-model="params.targetReturn" :min="10" :max="500" :step="10" />
      <ParamSlider label="容忍最大回撤" unit="%" v-model="params.maxDrawdown" :min="5" :max="80" :step="1" />
      <ParamSlider label="年均交易笔数" unit="笔" v-model="params.tradesPerYear" :min="1" :max="500" :step="1" />

      <n-button type="primary" size="large" block :loading="isSimulating" @click="runSimulation">
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="margin-right:4px">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" stroke-width="2"/>
            <path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </template>
        🎲 执行重新洗牌
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { NInputNumber, NButton } from 'naive-ui'
import ParamSlider from './ParamSlider.vue'
import type { SimParams } from './useKellySimulation'

defineProps<{
  params: SimParams
  isSimulating: boolean
}>()

const emit = defineEmits<{
  run: []
}>()

function runSimulation() {
  emit('run')
}

const isNarrow = ref(false)
const isCollapsed = ref(true)

function toggleCollapse() {
  if (isNarrow.value) {
    isCollapsed.value = !isCollapsed.value
  }
}

function onResize() {
  isNarrow.value = window.innerWidth < 1200
  if (!isNarrow.value) {
    isCollapsed.value = false
  }
}

onMounted(() => {
  onResize()
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
})
</script>

<style scoped>
.param-panel {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
  width: 280px;
  flex-shrink: 0;
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  cursor: default;
}
.collapse-icon {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-text-muted);
}
@media (max-width: 1200px) {
  .panel-header {
    cursor: pointer;
  }
}
.panel-icon {
  width: 36px;
  height: 36px;
  background: color-mix(in srgb, var(--color-primary) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 30%, transparent);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  flex-shrink: 0;
}
.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.2;
}
.panel-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}
.panel-body {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
}
.field-unit {
  color: var(--color-text-muted);
  font-weight: 400;
}
</style>
