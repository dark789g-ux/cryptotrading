<template>
  <n-tabs
    v-model:value="subTab"
    type="line"
    animated
    display-directive="show:lazy"
  >
    <n-tab-pane name="stocks" tab="美股">
      <us-stocks-panel />
    </n-tab-pane>
    <n-tab-pane name="index" tab="美股指数">
      <us-index-panel ref="indexPanelRef" />
    </n-tab-pane>
  </n-tabs>
</template>

<script setup lang="ts">
defineOptions({ name: 'UsStocksTabsContainer' })

import { nextTick, onActivated, ref, watch } from 'vue'
import { NTabPane, NTabs } from 'naive-ui'
import UsStocksPanel from './UsStocksPanel.vue'
import UsIndexPanel from '../us-index/UsIndexPanel.vue'

const subTab = ref<'stocks' | 'index'>('stocks')
const indexPanelRef = ref<{ resize: () => void } | null>(null)

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
