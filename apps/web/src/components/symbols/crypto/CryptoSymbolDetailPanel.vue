<template>
  <div class="crypto-symbol-detail-panel">
    <div v-if="loading" class="panel-center">
      <n-spin />
    </div>
    <n-empty v-else-if="!displayKlineData.length" description="No kline data" class="panel-empty" />
    <kline-chart
      v-else
      :data="displayKlineData"
      height="100%"
      :slider-start="70"
      show-toolbar
      :granularity="cryptoGranularity"
      :range="klineRange"
      prefs-key="crypto"
      :available-subplots="cryptoAvailableSubplots"
      :recalc-indicators="recalcKdjIndicators"
      @update:range="onKlineRangeChange"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'CryptoSymbolDetailPanel' })

import { computed, ref, watch } from 'vue'
import { NEmpty, NSpin, useMessage } from 'naive-ui'
import KlineChart from '../../kline/KlineChart.vue'
import { klinesApi, type KlineChartBar, type SymbolRow } from '@/api'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'
import { sliceTimestampBarsByRange } from '@/composables/kline/klineDateRange'
import type { IndicatorSubplotParams, SubplotKey } from '@/composables/kline/subplotConfig'

const props = defineProps<{
  row: SymbolRow
  interval: '1h' | '4h' | '1d'
}>()

const message = useMessage()

const loading = ref(false)
const klineData = ref<KlineChartBar[]>([])

const cryptoGranularity = computed<'date' | 'hour' | 'minute'>(() =>
  props.interval === '1d' ? 'date' : 'hour',
)

const cryptoAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

const {
  range: klineRange,
  onRangeUpdate: onKlineRangeChange,
  reset: resetKlineRange,
} = useKlineRangePicker()

const displayKlineData = computed<KlineChartBar[]>(() =>
  sliceTimestampBarsByRange(klineData.value, klineRange.value, cryptoGranularity.value),
)

async function loadKlines() {
  const symbol = props.row?.symbol
  if (!symbol) return
  loading.value = true
  klineData.value = []
  resetKlineRange()
  try {
    klineData.value = await klinesApi.getKlines(symbol, props.interval)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function recalcKdjIndicators(params?: IndicatorSubplotParams): Promise<void> {
  const symbol = props.row?.symbol
  if (!symbol) return
  try {
    const result = await klinesApi.recalcKlines(symbol, props.interval, { kdjParams: params?.KDJ })
    klineData.value = result
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    throw err
  }
}

defineExpose({ recalcKdjIndicators })

watch(
  () => [props.row?.symbol, props.interval] as const,
  () => void loadKlines(),
  { immediate: true },
)
</script>

<style scoped>
.crypto-symbol-detail-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 620px;
}

.panel-center,
.panel-empty {
  align-items: center;
  display: flex;
  flex: 1;
  justify-content: center;
}
</style>
