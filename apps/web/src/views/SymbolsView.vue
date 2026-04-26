<template>
  <div class="symbols-view workspace-page">
    <div class="workspace-page-header symbols-header">
      <div>
        <h1 class="workspace-page-title">Symbols</h1>
        <p class="page-subtitle">标的工作台</p>
      </div>
      <n-tabs v-model:value="activeTab" type="segment" animated class="symbols-tabs">
        <n-tab name="crypto">加密标的</n-tab>
        <n-tab name="aShares">A 股数据</n-tab>
      </n-tabs>
    </div>

    <crypto-symbols-panel v-if="activeTab === 'crypto'" />
    <a-shares-panel v-else />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SymbolsView' })

import { ref } from 'vue'
import { NTab, NTabs } from 'naive-ui'
import ASharesPanel from '../components/symbols/ASharesPanel.vue'
import CryptoSymbolsPanel from '../components/symbols/CryptoSymbolsPanel.vue'

const activeTab = ref<'crypto' | 'aShares'>('crypto')
</script>

<style scoped>
.symbols-view { max-width: 1400px; }
.symbols-header { align-items: center; }
.page-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }
.symbols-tabs { width: 260px; }
</style>
