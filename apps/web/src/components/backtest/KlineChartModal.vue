<template>
  <n-modal
    :show="show"
    :title="modalTitle"
    preset="card"
    :style="modalStyle"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
    <template #header-extra>
      <n-button text style="margin-right: 4px" @click="toggleFullscreen">
        <template #icon>
          <n-icon><contract-outline v-if="isFullscreen" /><expand-outline v-else /></n-icon>
        </template>
      </n-button>
    </template>

    <n-empty
      v-if="!symbol?.trim()"
      description="No symbol selected"
      style="padding: 40px 0"
    />
    <template v-else>
      <div v-if="loading" class="chart-center">
        <n-spin />
      </div>
      <n-empty
        v-else-if="!klineData.length"
        description="No kline data"
        style="padding: 40px 0"
      />
      <!-- Tier 3 豁免日期选择器：本图以回测某根 K 线为锚点取前 100/后 30 根（窗口 ~130 根），
           配 :current-ts 高亮信号 K 线；语义是"看信号 K 线上下文"，按日期裁会把锚点/信号裁掉，故保持 disabled-range。 -->
      <kline-chart
        v-else
        :data="klineData"
        :height="chartHeight"
        :current-ts="ts"
        :slider-start="0"
        show-toolbar
        granularity="date"
        :range="null"
        disabled-range
        prefs-key="backtest"
        :available-subplots="backtestAvailableSubplots"
        :recalc-indicators="recalcKdjIndicators"
        :symbol-code="symbol ?? ''"
      />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NModal, NSpin, useMessage } from 'naive-ui'
import { ContractOutline, ExpandOutline } from '@vicons/ionicons5'
import KlineChart from '../kline/KlineChart.vue'
import type { IndicatorSubplotParams, SubplotKey } from '@/composables/kline/subplotConfig'
import { backtestApi, type KlineChartBar } from '@/api'

// 回测 K 线无活跃市值数据源：显式排除 0AMV / 0AMV_MACD，保持默认布局与接入前一致
const backtestAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK', 'FLOW']

const props = defineProps<{
  show: boolean
  runId: string | null
  ts: string
  symbol: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()

const loading = ref(false)
const klineData = ref<KlineChartBar[]>([])
const isFullscreen = ref(false)

const modalTitle = computed(() => {
  const symbol = props.symbol?.trim() ?? ''
  const ts = props.ts ?? ''
  return symbol ? `Kline Chart · ${symbol} · ${ts}` : `Kline Chart · ${ts}`
})

const modalStyle = computed(() =>
  isFullscreen.value
    ? 'width: 100vw; height: 100vh; max-width: 100vw; border-radius: 0; margin: 0; top: 0; left: 0'
    : 'width: 1150px; max-width: 95vw',
)

const chartHeight = computed(() => (isFullscreen.value ? 'calc(100vh - 60px)' : '600px'))

const toggleFullscreen = () => {
  isFullscreen.value = !isFullscreen.value
}

const loadKline = async () => {
  const runId = props.runId
  const ts = props.ts?.trim() ?? ''
  const symbol = props.symbol?.trim() ?? ''
  if (!runId || !ts || !symbol) return

  loading.value = true
  klineData.value = []
  try {
    klineData.value = await backtestApi.getKlineChart(runId, {
      symbol,
      ts,
      before: 100,
      after: 30,
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }

}

async function recalcKdjIndicators(params?: IndicatorSubplotParams): Promise<void> {
  const runId = props.runId
  const ts = props.ts?.trim() ?? ''
  const symbol = props.symbol?.trim() ?? ''
  if (!runId || !ts || !symbol) return

  loading.value = true
  try {
    klineData.value = await backtestApi.recalcKlineChart(
      runId,
      { symbol, ts, before: 100, after: 30 },
      { kdjParams: params?.KDJ },
    )
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.runId, props.ts, props.symbol] as const,
  async ([show, runId, ts, symbol]) => {
    if (!show) {
      klineData.value = []
      isFullscreen.value = false
      return
    }
    if (!runId || !ts?.trim() || !symbol?.trim()) return
    await loadKline()
  },
)
</script>

<style scoped>
.chart-center {
  display: flex;
  justify-content: center;
  padding: 80px 0;
}
</style>
