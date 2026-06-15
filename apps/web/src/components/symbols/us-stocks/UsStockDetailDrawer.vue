<template>
  <n-drawer
    :show="show"
    width="min(1440px, 96vw)"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content class="us-stock-detail-drawer" closable>
      <template #header>
        <div v-if="row" class="drawer-title">
          <div class="symbol-line">
            <span class="symbol-name">美股详情 - {{ row.name }}</span>
            <n-tag size="small" :bordered="false">{{ row.ticker }}</n-tag>
          </div>
          <div class="symbol-meta">
            {{ row.theme ?? '-' }} / {{ row.stockType ?? '-' }} / {{ formatTradeDate(row.tradeDate) }} / {{ priceModeLabel }}
          </div>
        </div>
        <span v-else>美股详情</span>
      </template>

      <div v-if="row" class="detail-content">
        <div class="chart-panel">
          <div v-if="loading" class="chart-center">
            <n-spin />
          </div>
          <n-empty v-else-if="!klineRows.length" description="暂无K线数据" class="chart-empty" />
          <kline-chart
            v-else
            :data="klineRows"
            height="100%"
            :slider-start="35"
            show-toolbar
            granularity="date"
            :range="null"
            disabled-range
            prefs-key="us-stock"
            :available-subplots="usStockAvailableSubplots"
          />
        </div>
      </div>
      <n-empty v-else description="未选择股票" class="chart-empty" />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NDrawer,
  NDrawerContent,
  NEmpty,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui'
import KlineChart from '../../kline/KlineChart.vue'
import { type UsStockKlineBar, type UsStockRow } from '@/api'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { fetchUsStockKline } from './usStockDetailFetcher'
import { formatTradeDate } from '../a-shares/aSharesFormatters'

// 美股 K 线：仅基础技术副图（无资金流 / 无活跃市值）
const usStockAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD']

const props = defineProps<{
  show: boolean
  row: UsStockRow | null
  priceMode: 'qfq' | 'raw'
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const message = useMessage()

const loading = ref(false)
const klineRows = ref<UsStockKlineBar[]>([])

async function loadDetail() {
  const ticker = props.row?.ticker
  if (!ticker) return
  loading.value = true
  klineRows.value = []
  try {
    klineRows.value = await fetchUsStockKline(ticker, 360, props.priceMode)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.row?.ticker] as const,
  ([show, ticker]) => {
    if (!show) {
      klineRows.value = []
      return
    }
    if (!ticker) return
    void loadDetail()
  },
)

watch(
  () => props.priceMode,
  () => {
    if (!props.show || !props.row?.ticker) return
    void loadDetail()
  },
)

const priceModeLabel = computed(() => props.priceMode === 'raw' ? '不复权' : '前复权')
</script>

<style scoped>
.us-stock-detail-drawer :deep(.n-drawer-body) {
  flex: 1;
  min-height: 0;
}

.us-stock-detail-drawer :deep(.n-drawer-body-content-wrapper) {
  height: 100%;
  padding: 0;
}

.drawer-title {
  min-width: 0;
}

.symbol-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.symbol-name {
  color: var(--color-text);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.symbol-meta {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.detail-content,
.chart-panel {
  display: flex;
  flex: 1;
  height: 100%;
  min-height: 620px;
  min-width: 0;
}

.chart-center,
.chart-empty {
  align-items: center;
  display: flex;
  flex: 1;
  justify-content: center;
}

@media (max-width: 960px) {
  .detail-content,
  .chart-panel {
    min-height: 520px;
  }
}
</style>
