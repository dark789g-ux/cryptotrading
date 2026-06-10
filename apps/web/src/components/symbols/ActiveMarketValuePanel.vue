<template>
  <div class="active-mv-panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">活跃市值（0AMV）</h2>
        <p class="panel-subtitle">中证A股指数 930903.CSI 活跃市值指标</p>
      </div>
      <n-button :loading="syncing" @click="handleSync">
        <template #icon><n-icon><sync-outline /></n-icon></template>
        同步数据
      </n-button>
    </div>

    <n-card :bordered="false">
      <n-spin :show="loading">
        <kline-chart
          v-if="chartData.length > 0"
          :data="chartData"
          height="600px"
          show-toolbar
          granularity="date"
          :range="null"
          disabled-range
          prefs-key="oamv"
          :available-subplots="oamvAvailableSubplots"
        />
        <n-empty v-else description="暂无数据，请先同步" />
        <!-- 0AMV 副图合规标注（spec §7/§8）：信号未回测校准 -->
        <n-text :depth="3" class="amv-caption">{{ AMV_CAPTION_BASE }}</n-text>
      </n-spin>
    </n-card>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActiveMarketValuePanel' })

import { computed, onActivated, ref } from 'vue'
import { NButton, NCard, NEmpty, NIcon, NSpin, NText, useMessage } from 'naive-ui'
import { SyncOutline } from '@vicons/ionicons5'
import KlineChart from '@/components/kline/KlineChart.vue'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { AMV_CAPTION_BASE } from '@/composables/kline/amvCaption'
import { oamvApi, type OamvData } from '@/api/modules/market/oamv'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import { mapOamvToChartBar } from './oamvChartMapping'

const message = useMessage()

// 0AMV 面板：仅保留 KDJ / MACD，不含 VOL / BRICK（无成交量 / 砖图概念）
const oamvAvailableSubplots: SubplotKey[] = ['KDJ', 'MACD']
const loading = ref(false)
const syncing = ref(false)
const oamvData = ref<OamvData[]>([])

const chartData = computed<KlineChartBar[]>(() => oamvData.value.map(mapOamvToChartBar))

async function loadData() {
  loading.value = true
  try {
    oamvData.value = await oamvApi.getData(250)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '加载数据失败')
  } finally {
    loading.value = false
  }
}

async function handleSync() {
  syncing.value = true
  try {
    const result = await oamvApi.sync()
    message.success(`同步完成，共 ${result.synced} 条数据`)
    await loadData()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '同步失败')
  } finally {
    syncing.value = false
  }
}

onActivated(() => {
  void loadData()
})
</script>

<style scoped>
.active-mv-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
}

.panel-subtitle {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}

.amv-caption {
  flex: 0 0 auto;
  padding: 4px 8px 2px;
  font-size: 12px;
  line-height: 1.4;
}
</style>
