<template>
  <div class="a-shares-index-panel">
    <n-tabs
      v-model:value="subTab"
      type="line"
      animated
      display-directive="show:lazy"
    >
      <n-tab-pane name="ths" tab="同花顺指数">
        <a-shares-index-ths-panel />
      </n-tab-pane>
      <n-tab-pane name="sw" tab="申万指数">
        <a-shares-index-sw-panel />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexPanel' })

import { onActivated, ref } from 'vue'
import { NTabPane, NTabs } from 'naive-ui'
import ASharesIndexThsPanel from './ASharesIndexThsPanel.vue'
import ASharesIndexSwPanel from './ASharesIndexSwPanel.vue'

const subTab = ref<'ths' | 'sw'>('ths')

// 与 ASharesTabsContainer 的 resize 契约对齐（表格无 ECharts，resize 为 no-op）。
// 本面板现已是 sub-tab 容器，各子面板自带 onMounted/onActivated reload（keep-alive 切回刷新）。
defineExpose({ resize: () => {} })

// 容器层保留 keep-alive 切回时的 resize 触发点（子面板各自 reload，无需在此转发）。
onActivated(() => {
  // no-op：子面板自行 onActivated reload
})
</script>

<style scoped>
.a-shares-index-panel {
  height: 100%;
}
</style>
