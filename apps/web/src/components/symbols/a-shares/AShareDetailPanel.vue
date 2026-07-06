<template>
  <div class="a-share-detail-panel">
    <template v-if="row">
      <div class="detail-content">
        <div class="chart-panel">
          <div v-if="loading" class="chart-center">
            <n-spin />
          </div>
          <n-empty v-else-if="!klineRows.length" description="暂无K线数据" class="chart-empty" />
          <div v-else class="chart-with-caption">
            <KlineWithInfoPanel storage-key="kline_info_panel_expanded_a_share" info-title="标的信息">
              <template #kline>
                <kline-chart
                  :data="klineRows"
                  height="100%"
                  :slider-start="35"
                  show-toolbar
                  granularity="date"
                  :range="klineRange"
                  prefs-key="a-share"
                  :available-subplots="aShareAvailableSubplots"
                  :recalc-indicators="recalcKdjIndicators"
                  :symbol-code="row?.tsCode"
                  :symbol-name="row?.name"
                  @update:range="onKlineRangeChange"
                />
              </template>
              <template #info>
                <AStockInfoFields :row="row" />
              </template>
            </KlineWithInfoPanel>
          </div>
        </div>
      </div>
    </template>
    <n-empty v-else description="未选择股票" class="chart-empty" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'AShareDetailPanel' })

import { ref, watch } from 'vue'
import { NEmpty, NSpin, useMessage } from 'naive-ui'
import KlineChart from '../../kline/KlineChart.vue'
import KlineWithInfoPanel from '../shared/KlineWithInfoPanel.vue'
import AStockInfoFields from './AStockInfoFields.vue'
import { aSharesApi, type AShareKlineBar, type AShareRow } from '@/api'
import type { AmvSeriesRow } from '@/api/modules/market/active-mv'
import type { IndicatorSubplotParams } from '@/composables/kline/subplotConfig'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'
import { useKlineRangePicker, type KlineRangeDates } from '@/composables/kline/useKlineRangePicker'
import { msToYyyymmdd } from '@/composables/kline/klineDateRange'
import { fetchAShareDetail, fetchAShareKlineOnly } from './aShareDetailFetcher'

// 个股 K 线：全副图 + 活跃市值（0AMV / 0AMV_MACD）
const aShareAvailableSubplots: SubplotKey[] = [
  'VOL', 'KDJ', 'MACD', 'BRICK', 'FLOW', '0AMV', '0AMV_MACD',
]

const props = withDefaults(
  defineProps<{
    row: AShareRow | null
    priceMode: 'qfq' | 'raw'
    /** 外部容器是否可见；用于 Drawer 场景在关闭时清空状态、打开时重新加载。split-right slot 等常驻场景可不传，默认为 true。 */
    visible?: boolean
  }>(),
  {
    visible: true,
  },
)

const message = useMessage()

// 默认窗口取最近 DEFAULT_LIMIT 根；选了区间则把 limit 放大到 RANGE_LIMIT（后端 safeLimit 硬上限），
// 覆盖约 4 年交易日——区间跨度超出时回区间内最近 RANGE_LIMIT 根（区间名不副实的边界，已知）。
const DEFAULT_LIMIT = 360
const RANGE_LIMIT = 1000

const loading = ref(false)
const klineRows = ref<AShareKlineBar[]>([])
// 缓存最近一次的资金流 raw 行，供 priceMode 切换路径复用
const cachedFlowRows = ref<MoneyFlowRowLike[]>([])
// 缓存最近一次的 AMV 序列，供 priceMode 切换路径复用（重 merge 不重拉）
const cachedAmvRows = ref<AmvSeriesRow[]>([])

// B 类服务端重查：选区间 → 以 start/end 重查（limit 放大）；清空 → 回默认窗口（limit=DEFAULT_LIMIT）。
const { range: klineRange, onRangeUpdate: onKlineRangeChange, reset: resetKlineRange } =
  useKlineRangePicker((r) => loadDetail(r))

// 当前选区的 YYYYMMDD 表示（priceMode 切换路径需据此带上区间重拉 K 线）。
function currentRangeDates(): KlineRangeDates | null {
  const r = klineRange.value
  return r ? { startDate: msToYyyymmdd(r[0]), endDate: msToYyyymmdd(r[1]) } : null
}

/** 切换 row / 外部容器显隐 / 选区重查：并行拉 K 线 + 资金流 + AMV（K 线带 range） */
async function loadDetail(rangeDates: KlineRangeDates | null) {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  klineRows.value = []
  cachedFlowRows.value = []
  cachedAmvRows.value = []
  try {
    const limit = rangeDates ? RANGE_LIMIT : DEFAULT_LIMIT
    const result = await fetchAShareDetail(tsCode, limit, props.priceMode, rangeDates ?? undefined)
    klineRows.value = result.kline
    cachedFlowRows.value = result.flowRows
    cachedAmvRows.value = result.amvRows
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

/** priceMode 切换：只重拉 K 线（带当前选区），资金流由缓存重新 merge */
async function reloadKlineOnly() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  try {
    const rangeDates = currentRangeDates()
    const limit = rangeDates ? RANGE_LIMIT : DEFAULT_LIMIT
    const rawKline = await fetchAShareKlineOnly(tsCode, limit, props.priceMode, rangeDates ?? undefined)
    // 把缓存的资金流 + AMV 挂回新 K 线（开发模式下若日期格式漂移 R3 探针会触发）
    klineRows.value = mergeKlineWithAmv(
      mergeKlineWithMoneyFlow(rawKline, cachedFlowRows.value),
      cachedAmvRows.value,
    )
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function recalcKdjIndicators(params?: IndicatorSubplotParams): Promise<void> {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  const rangeDates = currentRangeDates()
  const limit = rangeDates ? RANGE_LIMIT : DEFAULT_LIMIT
  try {
    const rawKline = await aSharesApi.recalcKlines(
      tsCode,
      limit,
      props.priceMode,
      rangeDates ?? undefined,
      { kdjParams: params?.KDJ },
    )
    klineRows.value = mergeKlineWithAmv(
      mergeKlineWithMoneyFlow(rawKline, cachedFlowRows.value),
      cachedAmvRows.value,
    )
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    throw err
  }
}

watch(
  () => [props.visible, props.row?.tsCode] as const,
  ([visible, tsCode]) => {
    if (visible === false) {
      klineRows.value = []
      cachedFlowRows.value = []
      cachedAmvRows.value = []
      resetKlineRange()
      return
    }
    if (!tsCode) return
    // 切 row / 打开：回默认窗口（清空选区）后加载
    resetKlineRange()
    void loadDetail(null)
  },
  { immediate: true },
)

watch(
  () => props.priceMode,
  () => {
    if (props.visible === false || !props.row?.tsCode) return
    void reloadKlineOnly()
  },
)
</script>

<style scoped>
.a-share-detail-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
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

/* 图：竖排，图占满剩余高度 */
.chart-with-caption {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* KlineChart 根元素（.kline-chart-wrapper）占满剩余高度 */
.chart-with-caption > :first-child {
  flex: 1 1 auto;
  min-height: 0;
}

@media (max-width: 960px) {
  .detail-content,
  .chart-panel {
    min-height: 520px;
  }
}
</style>
