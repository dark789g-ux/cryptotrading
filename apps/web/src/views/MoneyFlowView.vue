<template>
  <div class="money-flow-view workspace-page">
    <div class="workspace-page-header money-flow-header">
      <div>
        <h1 class="workspace-page-title">Money Flow</h1>
        <p class="page-subtitle">A 股资金动向监测</p>
      </div>
      <div class="flow-tabs" role="tablist" aria-label="资金维度">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          class="flow-tabs__tab"
          :class="{ 'flow-tabs__tab--active': activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <keep-alive>
      <MarketFlowPanel v-if="activeTab === 'market'" />
      <IndustryFlowPanel v-else-if="activeTab === 'industry'" />
      <SectorFlowPanel v-else-if="activeTab === 'sector'" />
      <StockFlowPanel v-else />
    </keep-alive>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MoneyFlowView' })

import { ref } from 'vue'
import MarketFlowPanel from '../components/money-flow/MarketFlowPanel.vue'
import IndustryFlowPanel from '../components/money-flow/IndustryFlowPanel.vue'
import SectorFlowPanel from '../components/money-flow/SectorFlowPanel.vue'
import StockFlowPanel from '../components/money-flow/StockFlowPanel.vue'

type TabKey = 'market' | 'industry' | 'sector' | 'stock'

const tabs: { key: TabKey; label: string }[] = [
  { key: 'market', label: '大盘' },
  { key: 'industry', label: '行业' },
  { key: 'sector', label: '板块' },
  { key: 'stock', label: '个股' },
]

const activeTab = ref<TabKey>('market')
</script>

<style scoped>
.money-flow-view { max-width: 1600px; }
.money-flow-header { align-items: center; }
.page-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }

.flow-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 0 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
}

.flow-tabs__tab {
  position: relative;
  margin: 0;
  padding: 10px 16px 12px;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.flow-tabs__tab:hover { color: var(--color-text); }

.flow-tabs__tab--active { color: var(--color-text); }

.flow-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px 2px 0 0;
}

.flow-tabs__tab:not(.flow-tabs__tab--active)::after {
  opacity: 0;
}
</style>
