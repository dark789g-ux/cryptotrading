<template>
  <n-tabs
    v-model:value="subTab"
    type="line"
    animated
    display-directive="show:lazy"
  >
    <n-tab-pane name="stocks" tab="股票">
      <a-shares-panel ref="stocksPanelRef" />
    </n-tab-pane>
    <n-tab-pane name="index" tab="A 股指数">
      <a-shares-index-panel ref="indexPanelRef" @switch-to-stocks="handleSwitchToStocks" />
    </n-tab-pane>
  </n-tabs>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesTabsContainer' })

import { nextTick, onActivated, ref, watch } from 'vue'
import { NTabPane, NTabs } from 'naive-ui'
import ASharesPanel from './ASharesPanel.vue'
import ASharesIndexPanel from './a-shares-index/ASharesIndexPanel.vue'

const subTab = ref<'stocks' | 'index'>('stocks')
const indexPanelRef = ref<{ resize: () => void } | null>(null)
const stocksPanelRef = ref<{ applyIndexFilter: (tsCode: string, name: string) => void } | null>(null)

function handleSwitchToStocks(payload: { tsCode: string; name: string }) {
  stocksPanelRef.value?.applyIndexFilter(payload.tsCode, payload.name)
  subTab.value = 'stocks'
}

// echarts inside the index pane does not auto-resize after being lazily revealed; resize on switch in.
watch(subTab, (value) => {
  if (value === 'index') {
    void nextTick(() => indexPanelRef.value?.resize())
  }
})

// This container lives inside SymbolsView top-level <keep-alive>; resize when switching back if currently on index.
onActivated(() => {
  if (subTab.value === 'index') {
    void nextTick(() => indexPanelRef.value?.resize())
  }
})
</script>
