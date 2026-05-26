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
      </n-spin>
    </n-card>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActiveMarketValuePanel' })

import { computed, onActivated, ref } from 'vue'
import { NButton, NCard, NEmpty, NIcon, NSpin, useMessage } from 'naive-ui'
import { SyncOutline } from '@vicons/ionicons5'
import KlineChart from '@/components/kline/KlineChart.vue'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { oamvApi, type OamvData } from '@/api/modules/market/oamv'
import type { KlineChartBar } from '@/api/modules/market/symbols'

const message = useMessage()

// OAMV 无 moneyFlow 数据源，排除 FLOW 副图
const oamvAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']
const loading = ref(false)
const syncing = ref(false)
const oamvData = ref<OamvData[]>([])

/**
 * 将 0AMV 数据转换为 KlineChartBar 格式
 */
const chartData = computed<KlineChartBar[]>(() => {
  return oamvData.value.map(d => {
    // 将 YYYYMMDD 格式转换为 YYYY-MM-DD
    const date = `${d.tradeDate.slice(0, 4)}-${d.tradeDate.slice(4, 6)}-${d.tradeDate.slice(6, 8)}`
    return {
      open_time: date,
      open: Number(d.open),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      volume: 0, // 0AMV 无成交量概念
      // 其他字段设为 null
      MA5: null,
      MA30: null,
      MA60: null,
      MA120: null,
      MA240: null,
      'KDJ.K': null,
      'KDJ.D': null,
      'KDJ.J': null,
      DIF: null,
      DEA: null,
      MACD: null,
      BBI: null,
      brickChart: undefined,
    }
  })
})

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
</style>
