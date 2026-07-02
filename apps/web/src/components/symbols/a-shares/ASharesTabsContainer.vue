<template>
  <n-tabs
    v-model:value="subTab"
    type="line"
    animated
  >
    <!--
      display-directive 必须写在 n-tab-pane 上：naive-ui 的 <n-tabs> 没有该 prop，
      渲染时 filterMapTabPanes 只读各 pane 自身的 display-directive（默认 'if' = v-if）。
      写在 <n-tabs> 上是被忽略的透传属性、零效果。股票 pane 用 'show'（v-show 常驻挂载），
      使其在用户停留「A 股指数」子 tab 时仍保持挂载，stocksPanelRef 始终绑定 →
      「成分股」跨 tab 过滤可用。
    -->
    <n-tab-pane name="stocks" tab="股票" display-directive="show">
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
import ASharesIndexPanel from '../a-shares-index/ASharesIndexPanel.vue'

const subTab = ref<'stocks' | 'index'>('stocks')
const indexPanelRef = ref<{ resize: () => void } | null>(null)
const stocksPanelRef = ref<{
  applyIndexFilter: (
    tsCode: string,
    name: string,
    opts?: { category?: string; customIndexId?: string; memberTsCodes?: string[] },
  ) => Promise<void>
} | null>(null)

function handleSwitchToStocks(payload: {
  tsCode: string
  name: string
  category?: string
  customIndexId?: string
  memberTsCodes?: string[]
}) {
  // 「股票」pane 用 display-directive="show" 常驻挂载，此处 stocksPanelRef 必已绑定。
  // 先切到「股票」tab，再下发指数过滤；不再用静默 ?.（旧实现里 ref 未挂载时会被
  // 可选链整体短路，导致点击无反应、不报错——见 bug 修复）。
  const panel = stocksPanelRef.value
  if (!panel) {
    console.warn('[ASharesTabsContainer] stocksPanelRef 未就绪，无法应用指数过滤')
    return
  }
  subTab.value = 'stocks'
  void panel
    .applyIndexFilter(payload.tsCode, payload.name, {
      category: payload.category,
      customIndexId: payload.customIndexId,
      memberTsCodes: payload.memberTsCodes,
    })
}

watch(subTab, (value) => {
  if (value === 'index') {
    void nextTick(() => indexPanelRef.value?.resize())
  }
})

onActivated(() => {
  if (subTab.value === 'index') {
    void nextTick(() => indexPanelRef.value?.resize())
  }
})
</script>
