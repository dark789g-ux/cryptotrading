<template>
  <div class="sync-view workspace-page workspace-page--medium">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">数据同步</h1>
    </div>

    <n-card class="one-click-card" title="一键同步" :bordered="false">
      <OneClickSyncPanel :controller="oneClickCtrl" />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useMessage, NCard } from 'naive-ui'
import OneClickSyncPanel from '../../components/sync/OneClickSyncPanel.vue'
import { useOneClickSync } from '../../components/sync/useOneClickSync'
import { useOneClickSyncStore } from '../../stores/oneClickSync'

const message = useMessage()
const oneClickCtrl = useOneClickSync(message)
const oneClickStore = useOneClickSyncStore()

// 进页面：从后端恢复活跃/最近 run（刷新、切页、换设备都能看到进度），running 则恢复 2s 轮询。
// 状态全在 Pinia store（导航不销毁 store），故不需要 keep-alive。
onMounted(async () => {
  try {
    await oneClickStore.fetchActive()
    oneClickStore.resumeAllPolling()
  } catch (e) {
    message.error(e instanceof Error ? e.message : '加载一键同步状态失败')
  }
})

// 离开页面停轮询（后端照跑，回页 fetchActive + resume 重新接管）。
onUnmounted(() => {
  oneClickStore.stopPolling()
})
</script>

<style scoped src="./SyncView.styles.css"></style>
