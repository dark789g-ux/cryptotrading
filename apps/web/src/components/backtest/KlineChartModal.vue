<template>
  <n-modal
    :show="show"
    :title="modalTitle"
    preset="card"
    style="width: 1150px; max-width: 95vw"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
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
      <div v-else ref="chartRef" class="kline-chart" />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { NEmpty, NModal, NSpin, useMessage } from 'naive-ui'
import { buildKlineChartGraphics, buildKlineChartOption } from '../../composables/klineChartOptions'
import { backtestApi, type KlineChartBar } from '../../composables/useApi'
import { useTheme } from '../../composables/useTheme'

const props = defineProps<{
  show: boolean
  runId: string | null
  ts: string
  symbol: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()
const { echartsTheme } = useTheme()

const loading = ref(false)
const klineData = ref<KlineChartBar[]>([])
const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null

const modalTitle = computed(() => {
  const symbol = props.symbol?.trim() ?? ''
  const ts = props.ts ?? ''
  return symbol ? `Kline Chart · ${symbol} · ${ts}` : `Kline Chart · ${ts}`
})

const handleResize = () => chartInstance?.resize()

const renderChart = () => {
  const el = chartRef.value
  const data = klineData.value
  if (!el || !data.length) return

  chartInstance?.dispose()
  chartInstance = echarts.init(el)
  chartInstance.setOption(
    buildKlineChartOption({
      data,
      echartsTheme: echartsTheme.value,
      currentTs: props.ts ?? '',
      sliderStart: 0,
    }),
  )

  const lastIdx = data.length - 1
  chartInstance.on('updateAxisPointer', (ev: unknown) => {
    const event = ev as { axesInfo?: { axisDim: string; value: number }[] }
    const info = event.axesInfo?.find((item) => item.axisDim === 'x')
    const idx = typeof info?.value === 'number' ? info.value : lastIdx
    const safeIdx = idx >= 0 && idx < data.length ? idx : lastIdx
    chartInstance?.setOption({ graphic: buildKlineChartGraphics(safeIdx, data) })
  })

  window.removeEventListener('resize', handleResize)
  window.addEventListener('resize', handleResize)
}

const loadKline = async () => {
  const runId = props.runId
  const ts = props.ts?.trim() ?? ''
  const symbol = props.symbol?.trim() ?? ''
  if (!runId || !ts || !symbol) return

  chartInstance?.dispose()
  chartInstance = null
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

  if (!klineData.value.length) return
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  renderChart()
}

watch(
  () => [props.show, props.runId, props.ts, props.symbol] as const,
  async ([show, runId, ts, symbol]) => {
    if (!show) {
      chartInstance?.dispose()
      chartInstance = null
      klineData.value = []
      return
    }
    if (!runId || !ts?.trim() || !symbol?.trim()) return
    await loadKline()
  },
)

onUnmounted(() => {
  chartInstance?.dispose()
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.kline-chart {
  height: 600px;
  width: 100%;
}

.chart-center {
  display: flex;
  justify-content: center;
  padding: 80px 0;
}
</style>
