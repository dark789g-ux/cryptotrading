<template>
  <div ref="chartRef" class="kline-chart" :style="chartStyle" />
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { buildKlineChartGraphics, buildKlineChartOption } from '../../composables/kline/klineChartOptions'
import type { KlineChartBar } from '../../composables/useApi'
import { useTheme } from '../../composables/useTheme'

const props = withDefaults(
  defineProps<{
    data: KlineChartBar[]
    currentTs?: string
    sliderStart?: number
    height?: string | number
  }>(),
  {
    currentTs: '',
    sliderStart: 0,
    height: '600px',
  },
)

const { echartsTheme } = useTheme()
const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const chartStyle = computed(() => ({
  width: '100%',
  height: typeof props.height === 'number' ? `${props.height}px` : props.height,
}))

function disposeChart() {
  chartInstance?.dispose()
  chartInstance = null
}

function handleResize() {
  chartInstance?.resize()
}

function disconnectResizeObserver() {
  resizeObserver?.disconnect()
  resizeObserver = null
}

function observeChartResize(el: HTMLElement) {
  if (!window.ResizeObserver) return
  if (resizeObserver) return
  resizeObserver = new ResizeObserver(() => {
    handleResize()
  })
  resizeObserver.observe(el)
}

async function renderChart() {
  const data = props.data
  if (!data.length) {
    disposeChart()
    return
  }

  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  const el = chartRef.value
  if (!el) return
  observeChartResize(el)

  disposeChart()
  chartInstance = echarts.init(el)
  chartInstance.setOption(
    buildKlineChartOption({
      data,
      echartsTheme: echartsTheme.value,
      currentTs: props.currentTs,
      sliderStart: props.sliderStart,
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
}

watch(
  () => [props.data, props.currentTs, props.sliderStart, echartsTheme.value] as const,
  () => {
    void renderChart()
  },
  { immediate: true },
)

watch(
  () => props.height,
  async () => {
    await nextTick()
    handleResize()
  },
)

window.addEventListener('resize', handleResize)

onUnmounted(() => {
  disconnectResizeObserver()
  disposeChart()
  window.removeEventListener('resize', handleResize)
})

defineExpose({ resize: handleResize, renderChart })
</script>

<style scoped>
.kline-chart {
  min-height: 320px;
}
</style>
