<template>
  <div class="equity-chart-wrap">
    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div v-else-if="rows.length === 0" class="state">该运行暂无净值数据</div>
    <div v-else ref="el" class="equity-chart"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { signalStatsApi } from '../../api/modules/strategy/signalStats'
import type { SignalTestEquityRow } from '../../api/modules/strategy/signalStats'
import { formatTradeDate } from '../symbols/a-shares/aSharesFormatters'

/**
 * 迷你回测净值曲线：拉 GET equity，nav 归一为 initialCapital=1 净值，叠加回撤带。
 * init/resize/dispose 模式照搬 PortfolioSimNavChart；fetch + v-if 门控参考 RetHistogram。
 */
const props = defineProps<{
  testId: string
  runId: string
}>()

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let ro: ResizeObserver | null = null

const loading = ref(false)
const error = ref<string | null>(null)
const rows = ref<SignalTestEquityRow[]>([])

interface NavPoint {
  date: string
  navUnit: number
  dailyRet: number
  drawdown: number
}

function buildPoints(): NavPoint[] {
  const raw = rows.value.map((r) => {
    const nav = parseFloat(r.nav)
    const ret = parseFloat(r.dailyRet)
    return { date: r.tradeDate, nav, dailyRet: Number.isFinite(ret) ? ret : NaN }
  })
  const base = raw.length > 0 && Number.isFinite(raw[0].nav) && raw[0].nav > 0 ? raw[0].nav : 1
  let peak = -Infinity
  return raw.map((p) => {
    const navUnit = Number.isFinite(p.nav) ? p.nav / base : NaN
    if (Number.isFinite(navUnit)) peak = Math.max(peak, navUnit)
    const drawdown = Number.isFinite(navUnit) && peak > 0 ? navUnit / peak - 1 : NaN
    return { date: p.date, navUnit, dailyRet: p.dailyRet, drawdown }
  })
}

function render() {
  if (!chart) return
  const points = buildPoints()
  const dates = points.map((p) => p.date)
  chart.setOption({
    grid: { left: 56, right: 56, top: 24, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        if (!arr.length) return ''
        const p = points[arr[0].dataIndex]
        if (!p) return ''
        const retPct = Number.isFinite(p.dailyRet) ? `${(p.dailyRet * 100).toFixed(2)}%` : '—'
        const nav = Number.isFinite(p.navUnit) ? p.navUnit.toFixed(4) : '—'
        const dd = Number.isFinite(p.drawdown) ? `${(p.drawdown * 100).toFixed(2)}%` : '—'
        return `${formatTradeDate(p.date)}<br/>净值：${nav}<br/>当日收益：${retPct}<br/>回撤：${dd}`
      },
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLabel: { color: '#a0a4ab', formatter: (v: string) => formatTradeDate(v) },
    },
    yAxis: [
      {
        type: 'value',
        scale: true,
        name: '净值',
        nameTextStyle: { color: '#a0a4ab' },
        axisLabel: { color: '#a0a4ab' },
        splitLine: { lineStyle: { color: 'rgba(160,164,171,0.15)' } },
      },
      {
        type: 'value',
        name: '回撤',
        max: 0,
        position: 'right',
        nameTextStyle: { color: '#a0a4ab' },
        axisLabel: { color: '#a0a4ab', formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '净值',
        type: 'line',
        yAxisIndex: 0,
        showSymbol: false,
        lineStyle: { width: 1.6, color: '#2080f0' },
        areaStyle: { color: 'rgba(32,128,240,0.08)' },
        data: points.map((p) => (Number.isFinite(p.navUnit) ? p.navUnit : null)),
      },
      {
        name: '回撤',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { width: 1, color: '#d03050', opacity: 0.6 },
        areaStyle: { color: 'rgba(208,48,80,0.08)' },
        data: points.map((p) => (Number.isFinite(p.drawdown) ? p.drawdown : null)),
      },
    ],
  })
}

function initOrRender() {
  if (!el.value) return
  if (!chart) {
    chart = echarts.init(el.value)
    ro = new ResizeObserver(() => chart?.resize())
    ro.observe(el.value)
  }
  render()
}

async function fetchAndRender() {
  loading.value = true
  error.value = null
  rows.value = []
  try {
    const result = await signalStatsApi.getEquity(props.testId, props.runId)
    rows.value = result
    loading.value = false
    await nextTick()
    if (result.length === 0) return
    initOrRender()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '加载净值曲线失败'
    loading.value = false
  }
}

onMounted(() => {
  fetchAndRender()
})

onUnmounted(() => {
  ro?.disconnect()
  chart?.dispose()
  chart = null
})

watch(
  () => props.runId,
  () => {
    if (chart) {
      chart.dispose()
      chart = null
      ro?.disconnect()
      ro = null
    }
    fetchAndRender()
  },
)
</script>

<style scoped>
.equity-chart-wrap {
  width: 100%;
  min-height: 240px;
}
.equity-chart {
  width: 100%;
  height: 320px;
}
.state {
  padding: 24px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}
.state.error {
  color: var(--color-error);
}
</style>
