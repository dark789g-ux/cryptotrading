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
          <div v-else class="chart-with-caption">
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
              @update:range="onKlineRangeChange"
            />
            <!-- 0AMV 副图合规标注（spec §8/§11）：信号未回测校准 -->
            <n-text :depth="3" class="amv-caption">{{ AMV_CAPTION_BASE }}</n-text>
          </div>
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
  NText,
  useMessage,
} from 'naive-ui'
import KlineChart from '../../kline/KlineChart.vue'
import { aSharesApi, type AShareKlineBar, type AShareRow } from '@/api'
import type { AmvSeriesRow } from '@/api/modules/market/active-mv'
import type { IndicatorSubplotParams } from '@/composables/kline/subplotConfig'
import { AMV_CAPTION_BASE } from '@/composables/kline/amvCaption'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'
import { useKlineRangePicker, type KlineRangeDates } from '@/composables/kline/useKlineRangePicker'
import { msToYyyymmdd } from '@/composables/kline/klineDateRange'
import { fetchAShareDetail, fetchAShareKlineOnly } from './aShareDetailFetcher'
import { formatTradeDate } from './aSharesFormatters'

// 个股 K 线：全副图 + 活跃市值（0AMV / 0AMV_MACD）
const aShareAvailableSubplots: SubplotKey[] = [
  'VOL', 'KDJ', 'MACD', 'BRICK', 'FLOW', '0AMV', '0AMV_MACD',
]

const props = defineProps<{
  show: boolean
  row: AShareRow | null
  priceMode: 'qfq' | 'raw'
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

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

/** Drawer 打开 / row 切换 / 选区重查：并行拉 K 线 + 资金流 + AMV（K 线带 range） */
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
  () => [props.show, props.row?.tsCode] as const,
  ([show, tsCode]) => {
    if (!show) {
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

/* 图 + 标注：竖排，图占满剩余高度，标注占一行小字 */
.chart-with-caption {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* KlineChart 根元素（.kline-chart-wrapper）占满除标注外的剩余高度 */
.chart-with-caption > :first-child {
  flex: 1 1 auto;
  min-height: 0;
}

.amv-caption {
  flex: 0 0 auto;
  padding: 4px 8px 2px;
  font-size: 12px;
  line-height: 1.4;
}

@media (max-width: 960px) {
  .detail-content,
  .chart-panel {
    min-height: 520px;
  }
}
</style>
