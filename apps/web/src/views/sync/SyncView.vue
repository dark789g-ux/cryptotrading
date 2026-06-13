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
import { useMessage, NCard } from 'naive-ui'
import OneClickSyncPanel from '../../components/sync/OneClickSyncPanel.vue'
import { useOneClickSync } from '../../components/sync/useOneClickSync'

const message = useMessage()
const oneClickCtrl = useOneClickSync(message)
</script>

<style scoped src="./SyncView.styles.css"></style>
