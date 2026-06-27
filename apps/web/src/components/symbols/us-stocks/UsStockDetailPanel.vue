<template>
  <div class="us-stock-detail-panel">
    <div class="chart-panel">
      <KlineWithInfoPanel storage-key="kline_info_panel_expanded_us_stock" info-title="标的信息">
        <template #kline>
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
            :range="klineRange"
            prefs-key="us-stock"
            :available-subplots="usStockAvailableSubplots"
            :recalc-indicators="recalcKdjIndicators"
            :symbol-code="row?.ticker"
            :symbol-name="row?.name"
            @update:range="onKlineRangeChange"
          />
        </template>
        <template #info>
          <UsStockInfoFields :row="row" />
        </template>
      </KlineWithInfoPanel>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NEmpty, NSpin, useMessage } from 'naive-ui'
import KlineChart from '../../kline/KlineChart.vue'
import KlineWithInfoPanel from '../KlineWithInfoPanel.vue'
import UsStockInfoFields from './UsStockInfoFields.vue'
import { usStocksApi, type UsStockKlineBar, type UsStockRow } from '@/api'
import type { IndicatorSubplotParams, SubplotKey } from '@/composables/kline/subplotConfig'
import { useKlineRangePicker, type KlineRangeDates } from '@/composables/kline/useKlineRangePicker'
import { msToYyyymmdd } from '@/composables/kline/klineDateRange'
import { fetchUsStockKline } from './usStockDetailFetcher'

// 美股 K 线：仅基础技术副图（无资金流 / 无活跃市值）
const usStockAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD']

const props = defineProps<{
  row: UsStockRow | null
  priceMode: 'qfq' | 'raw'
}>()

const message = useMessage()

// 默认窗口取最近 DEFAULT_LIMIT 根；选了区间则把 limit 放大到 RANGE_LIMIT（后端 safeLimit 硬上限），
// 覆盖约 4 年交易日——区间跨度超出时回区间内最近 RANGE_LIMIT 根（已知边界）。
const DEFAULT_LIMIT = 360
const RANGE_LIMIT = 1000

const loading = ref(false)
const klineRows = ref<UsStockKlineBar[]>([])

// B 类服务端重查：选区间 → 以 start/end 重查；清空 → 回默认窗口（limit=DEFAULT_LIMIT）。
const { range: klineRange, onRangeUpdate: onKlineRangeChange, reset: resetKlineRange } =
  useKlineRangePicker((r) => loadDetail(r))

function currentRangeDates(): KlineRangeDates | null {
  const r = klineRange.value
  return r ? { startDate: msToYyyymmdd(r[0]), endDate: msToYyyymmdd(r[1]) } : null
}

async function loadDetail(rangeDates: KlineRangeDates | null) {
  const ticker = props.row?.ticker
  if (!ticker) return
  loading.value = true
  klineRows.value = []
  try {
    const limit = rangeDates ? RANGE_LIMIT : DEFAULT_LIMIT
    klineRows.value = await fetchUsStockKline(ticker, limit, props.priceMode, rangeDates ?? undefined)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function recalcKdjIndicators(params?: IndicatorSubplotParams): Promise<void> {
  const ticker = props.row?.ticker
  if (!ticker) return
  const rangeDates = currentRangeDates()
  const limit = rangeDates ? RANGE_LIMIT : DEFAULT_LIMIT
  try {
    klineRows.value = await usStocksApi.recalcKlines(
      ticker,
      limit,
      props.priceMode,
      rangeDates ?? undefined,
      { kdjParams: params?.KDJ },
    )
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    throw err
  }
}

watch(
  () => props.row?.ticker,
  (ticker) => {
    // 切 row / 首次挂载：回默认窗口（清空选区）后加载
    resetKlineRange()
    if (!ticker) {
      klineRows.value = []
      return
    }
    void loadDetail(null)
  },
  { immediate: true },
)

watch(
  () => props.priceMode,
  () => {
    if (!props.row?.ticker) return
    // priceMode 切换沿用当前选区重拉
    void loadDetail(currentRangeDates())
  },
)
</script>

<style scoped>
.us-stock-detail-panel,
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
  .us-stock-detail-panel,
  .chart-panel {
    min-height: 520px;
  }
}
</style>
