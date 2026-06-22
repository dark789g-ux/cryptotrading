<template>
  <div class="symbols-view workspace-page">
    <div class="workspace-page-header symbols-header">
      <div>
        <h1 class="workspace-page-title">Symbols</h1>
        <p class="page-subtitle">标的工作台</p>
      </div>
      <div class="symbol-tabs" role="tablist" aria-label="标的类型">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'crypto'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'crypto' }"
          @click="activeTab = 'crypto'"
        >
          加密标的
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'aShares'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'aShares' }"
          @click="activeTab = 'aShares'"
        >
          A 股数据
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'activeMarketValue'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'activeMarketValue' }"
          @click="activeTab = 'activeMarketValue'"
        >
          活跃市值
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'usStocks'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'usStocks' }"
          @click="activeTab = 'usStocks'"
        >
          美股
        </button>
      </div>
    </div>

    <keep-alive>
      <crypto-symbols-panel v-if="activeTab === 'crypto'" />
      <a-shares-tabs-container v-else-if="activeTab === 'aShares'" />
      <active-market-value-panel v-else-if="activeTab === 'activeMarketValue'" />
      <us-stocks-tabs-container v-else />
    </keep-alive>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SymbolsView' })

import { ref } from 'vue'
import ASharesTabsContainer from '../../components/symbols/ASharesTabsContainer.vue'
import CryptoSymbolsPanel from '../../components/symbols/CryptoSymbolsPanel.vue'
import ActiveMarketValuePanel from '../../components/symbols/ActiveMarketValuePanel.vue'
import UsStocksTabsContainer from '../../components/symbols/UsStocksTabsContainer.vue'

const activeTab = ref<'crypto' | 'aShares' | 'activeMarketValue' | 'usStocks'>('crypto')
</script>

<style scoped>
/* 宽表工作台：覆盖全局 .workspace-page 的 min(100%, 1480px) 限宽，
   让 Symbols 面板占满内容区水平空间 */
.symbols-view {
  width: 100%;
  max-width: none;
}
.symbols-header { align-items: center; }
.page-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }

.symbol-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 0 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
}

.symbol-tabs__tab {
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

.symbol-tabs__tab:hover {
  color: var(--color-text);
}

.symbol-tabs__tab:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

.symbol-tabs__tab--active {
  color: var(--color-text);
}

.symbol-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px 2px 0 0;
  opacity: 1;
  transform: scaleX(1);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.symbol-tabs__tab:not(.symbol-tabs__tab--active)::after {
  opacity: 0;
  transform: scaleX(0.6);
}
</style>
