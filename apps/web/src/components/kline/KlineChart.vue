<template>
  <div class="kline-chart-wrapper" :style="wrapperStyle">
    <kline-chart-toolbar
      v-if="showToolbar"
      class="kline-chart-wrapper__toolbar"
      :granularity="granularity"
      :range="range ?? null"
      :disabled-range="disabledRange"
      :prefs-key="prefsKey"
      :available-subplots="availableSubplots"
      @update:range="onRangeUpdate"
      @update:prefs="onPrefsUpdate"
    />
    <div ref="chartRef" class="kline-chart" :style="chartStyle" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import KlineChartToolbar from './KlineChartToolbar.vue'
import { buildKlineChartGraphics, buildKlineChartOption } from '../../composables/kline/klineChartOptions'
import {
  ALL_SUBPLOT_KEYS,
  defaultPrefsFor,
  normalizePrefs,
  resolveVisibleSubplots,
  type SubplotConfig,
  type SubplotKey,
  type SubplotPrefs,
} from '../../composables/kline/subplotConfig'
import type { KlineChartBar } from '@/api'
import { useTheme } from '../../composables/hooks/useTheme'

type Granularity = 'date' | 'hour' | 'minute'

const TOOLBAR_HEIGHT_PX = 44
const TOOLBAR_GAP_PX = 8

const props = withDefaults(
  defineProps<{
    data: KlineChartBar[]
    currentTs?: string
    sliderStart?: number
    height?: string | number
    /** 是否启用工具栏（含时间区间 + 副图设置）。三个调用点接入后建议传 true。 */
    showToolbar?: boolean
    granularity?: Granularity
    range?: [number, number] | null
    disabledRange?: boolean
    prefsKey?: string
    availableSubplots?: SubplotKey[]
  }>(),
  {
    currentTs: '',
    sliderStart: 0,
    height: '600px',
    showToolbar: false,
    granularity: 'date',
    range: null,
    disabledRange: false,
    prefsKey: 'default',
    availableSubplots: () => [...ALL_SUBPLOT_KEYS],
  },
)

const emit = defineEmits<{
  (e: 'update:range', value: [number, number] | null): void
}>()

const { echartsTheme } = useTheme()
const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null
let pendingGraphicFrame: number | null = null
let pendingGraphicIdx: number | null = null
let lastGraphicIdx: number | null = null

// 工具栏 mount 时会 emit 一次当前持久化偏好，覆盖此初始值
const localPrefs = ref<SubplotPrefs>(
  normalizePrefs(null, props.prefsKey, props.availableSubplots),
)

const subplots = computed<SubplotConfig[]>(() => resolveVisibleSubplots(localPrefs.value))

const wrapperStyle = computed(() => ({
  width: '100%',
  height: typeof props.height === 'number' ? `${props.height}px` : props.height,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: props.showToolbar ? `${TOOLBAR_GAP_PX}px` : '0',
}))

const chartStyle = computed(() => ({
  width: '100%',
  flex: '1 1 auto',
  minHeight: '0',
}))

function disposeChart() {
  cancelPendingGraphicUpdate()
  chartInstance?.dispose()
  chartInstance = null
  lastGraphicIdx = null
  pendingGraphicIdx = null
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

function cancelPendingGraphicUpdate() {
  if (pendingGraphicFrame === null) return
  window.cancelAnimationFrame(pendingGraphicFrame)
  pendingGraphicFrame = null
}

function scheduleGraphicUpdate(idx: number, data: KlineChartBar[], subs: SubplotConfig[]) {
  if (idx === lastGraphicIdx || idx === pendingGraphicIdx) return

  pendingGraphicIdx = idx
  if (pendingGraphicFrame !== null) return

  pendingGraphicFrame = window.requestAnimationFrame(() => {
    pendingGraphicFrame = null
    const nextIdx = pendingGraphicIdx
    pendingGraphicIdx = null
    if (nextIdx === null || nextIdx === lastGraphicIdx) return

    lastGraphicIdx = nextIdx
    chartInstance?.setOption(
      { graphic: buildKlineChartGraphics(nextIdx, data, subs) },
      { lazyUpdate: true, silent: true },
    )
  })
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
  const subs = subplots.value
  chartInstance.setOption(
    buildKlineChartOption({
      data,
      echartsTheme: echartsTheme.value,
      currentTs: props.currentTs,
      sliderStart: props.sliderStart,
      subplots: subs,
    }),
  )

  const lastIdx = data.length - 1
  lastGraphicIdx = lastIdx
  chartInstance.on('updateAxisPointer', (ev: unknown) => {
    const event = ev as { axesInfo?: { axisDim: string; value: number }[] }
    const info = event.axesInfo?.find((item) => item.axisDim === 'x')
    const idx = typeof info?.value === 'number' ? info.value : lastIdx
    const safeIdx = idx >= 0 && idx < data.length ? idx : lastIdx
    scheduleGraphicUpdate(safeIdx, data, subplots.value)
  })
}

function onRangeUpdate(value: [number, number] | null) {
  emit('update:range', value)
}

function onPrefsUpdate(value: SubplotPrefs) {
  localPrefs.value = value
}

watch(
  () => [props.data, props.currentTs, props.sliderStart, echartsTheme.value, subplots.value] as const,
  () => {
    void renderChart()
  },
  { immediate: true, deep: true },
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
.kline-chart-wrapper {
  box-sizing: border-box;
}

.kline-chart-wrapper__toolbar {
  flex: 0 0 auto;
}

.kline-chart {
  min-height: 320px;
}
</style>
