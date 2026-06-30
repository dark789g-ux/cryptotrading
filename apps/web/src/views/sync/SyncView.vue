<template>
  <div class="sync-view workspace-page workspace-page--medium">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">数据同步</h1>
    </div>

    <n-card class="one-click-card" title="一键同步" :bordered="false">
      <n-tabs type="line" v-model:value="activeTab">
        <n-tab-pane name="ashare" tab="A股">
          <OneClickSyncPanel
            :controller="aCtrl"
            title="一键同步 A 股核心数据"
            subtitle="基础数据 → A股数据 → 资金流向 → 同花顺/申万/大盘指数日线 → 个股/行业/板块 AMV → 大盘 0AMV"
          />
        </n-tab-pane>
        <n-tab-pane name="us" tab="美股">
          <OneClickSyncPanel
            :controller="usCtrl"
            title="一键同步美股数据"
            subtitle="美股个股 → 美股指数日线 → 美股指数 AMV"
          />
        </n-tab-pane>
        <n-tab-pane name="market-index-scope" tab="大盘宽基范围" display-directive="show:lazy">
          <MarketIndexScopePanel />
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useMessage, NCard, NTabs, NTabPane } from 'naive-ui'
import OneClickSyncPanel from '../../components/sync/OneClickSyncPanel.vue'
import MarketIndexScopePanel from './MarketIndexScopePanel.vue'
import { useOneClickSync } from '../../components/sync/useOneClickSync'
import { useUsOneClickSync } from '../../components/sync/useUsOneClickSync'
import { useOneClickSyncStore } from '../../stores/oneClickSync'
import { useUsOneClickSyncStore } from '../../stores/usOneClickSync'

const message = useMessage()
const activeTab = ref<'ashare' | 'us' | 'market-index-scope'>('ashare')

// A 股 / 美股各一个实现同一接口 OneClickPanelController 的 controller，喂给复用的 OneClickSyncPanel。
const aCtrl = useOneClickSync(message)
const usCtrl = useUsOneClickSync(message)
const aStore = useOneClickSyncStore()
const usStore = useUsOneClickSyncStore()

// 进页面：两 store 各自从后端恢复活跃/最近 run（刷新、切页、换设备都能看到进度），running 则恢复 2s 轮询。
// 非 lazy tabs：两面板同时挂载，状态全在各自 Pinia store（导航不销毁 store），故不需要 keep-alive。
onMounted(async () => {
  try {
    await aStore.fetchActive()
    aStore.resumeAllPolling()
  } catch (e) {
    message.error(e instanceof Error ? e.message : '加载 A 股一键同步状态失败')
  }
  try {
    await aStore.fetchLatestSuccess()
  } catch { /* 标签缺失不阻塞、不弹错 */ }
  try {
    await usStore.fetchActive()
    usStore.resumePolling()
  } catch (e) {
    message.error(e instanceof Error ? e.message : '加载美股一键同步状态失败')
  }
  try {
    await usStore.fetchLatestSuccess()
  } catch { /* 标签缺失不阻塞、不弹错 */ }
})

// 离开页面停轮询（后端照跑，回页 fetchActive + resume 重新接管）。
onUnmounted(() => {
  aStore.stopPolling()
  usStore.stopPolling()
})
</script>

<style scoped src="./SyncView.styles.css"></style>
