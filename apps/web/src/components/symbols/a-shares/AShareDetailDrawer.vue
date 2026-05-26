<template>
  <n-drawer
    :show="show"
    width="min(1440px, 96vw)"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content class="a-share-detail-drawer" closable>
      <template #header>
        <div v-if="row" class="drawer-title">
          <div class="symbol-line">
            <span class="symbol-name">A股详情 - {{ row.name }}</span>
            <n-tag size="small" :bordered="false">{{ row.tsCode }}</n-tag>
          </div>
          <div class="symbol-meta">
            {{ row.market ?? '-' }} / {{ row.industry ?? '-' }} / {{ formatTradeDate(row.tradeDate) }} / {{ priceModeLabel }}
          </div>
        </div>
        <span v-else>A股详情</span>
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
            prefs-key="a-share"
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
import { type AShareKlineBar, type AShareRow } from '@/api'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'
import { fetchAShareDetail, fetchAShareKlineOnly } from './aShareDetailFetcher'
import { formatTradeDate } from './aSharesFormatters'

const props = defineProps<{
  show: boolean
  row: AShareRow | null
  priceMode: 'qfq' | 'raw'
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const message = useMessage()

const loading = ref(false)
const klineRows = ref<AShareKlineBar[]>([])
// 缓存最近一次的资金流 raw 行，供 priceMode 切换路径复用
const cachedFlowRows = ref<MoneyFlowRowLike[]>([])

/** Drawer 打开 / row 切换：并行拉 K 线 + 资金流 */
async function loadDetail() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  klineRows.value = []
  cachedFlowRows.value = []
  try {
    const result = await fetchAShareDetail(tsCode, 360, props.priceMode)
    klineRows.value = result.kline
    cachedFlowRows.value = result.flowRows
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

/** priceMode 切换：只重拉 K 线，资金流由缓存重新 merge */
async function reloadKlineOnly() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  try {
    const rawKline = await fetchAShareKlineOnly(tsCode, 360, props.priceMode)
    // 把缓存的资金流挂回新 K 线（开发模式下若日期格式漂移 R3 探针会触发）
    klineRows.value = mergeKlineWithMoneyFlow(rawKline, cachedFlowRows.value)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.row?.tsCode] as const,
  ([show, tsCode]) => {
    if (!show) {
      klineRows.value = []
      cachedFlowRows.value = []
      return
    }
    if (!tsCode) return
    void loadDetail()
  },
)

watch(
  () => props.priceMode,
  () => {
    if (!props.show || !props.row?.tsCode) return
    void reloadKlineOnly()
  },
)

const priceModeLabel = computed(() => props.priceMode === 'raw' ? '原始价' : '前复权')
</script>

<style scoped>
.a-share-detail-drawer :deep(.n-drawer-body) {
  flex: 1;
  min-height: 0;
}

.a-share-detail-drawer :deep(.n-drawer-body-content-wrapper) {
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
