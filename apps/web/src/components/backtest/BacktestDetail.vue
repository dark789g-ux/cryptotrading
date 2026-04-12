<template>
  <div class="backtest-detail">
    <n-empty v-if="!run && !loading" description="暂无回测结果，请先运行回测" />
    <n-spin v-else-if="loading" style="width:100%;padding:60px 0;display:flex;justify-content:center" />

    <template v-else-if="run">
      <!-- 历史运行选择 -->
      <div class="run-selector">
        <n-select
          v-model:value="selectedRunId"
          :options="runOptions"
          @update:value="loadRun"
          style="width: 280px"
        />
        <span class="run-meta">{{ runMeta }}</span>
      </div>

      <template v-if="reportData">
        <!-- 统计概览 -->
        <div class="stats-grid">
          <div v-for="item in statItems" :key="item.label" class="stat-item">
            <span class="label">{{ item.label }}</span>
            <span class="value" :class="item.cls">{{ item.value }}</span>
          </div>
        </div>

        <n-divider />

        <!-- 收益曲线 -->
        <h4 class="section-title">资产净值曲线</h4>
        <div ref="chartRef" class="chart-container"></div>

        <n-divider />

        <!-- 仓位记录 -->
        <h4 class="section-title">仓位记录（{{ reportData.totalPositions }} 次）</h4>
        <n-data-table :columns="posColumns" :data="reportData.positions" :pagination="{ pageSize: 10 }" size="small" />

        <n-divider />

        <!-- 标的统计 -->
        <h4 class="section-title">标的盈亏统计</h4>
        <n-data-table :columns="symColumns" :data="reportData.symbols" :pagination="{ pageSize: 10 }" size="small" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as echarts from 'echarts'
import { useMessage } from 'naive-ui'
import { backtestApi } from '../../composables/useApi'
import { useTheme } from '../../composables/useTheme'

const props = defineProps<{ strategy: any; run: any; loading: boolean }>()

const message = useMessage()
const { echartsTheme } = useTheme()
const chartRef = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

const allRuns = ref<any[]>([])
const selectedRunId = ref<string | null>(null)
const reportData = ref<any>(null)

const runOptions = computed(() =>
  allRuns.value.map((r) => ({
    label: `${new Date(r.createdAt).toLocaleString('zh-CN')} · ${r.timeframe}`,
    value: r.id,
  }))
)

const runMeta = computed(() => {
  const r = allRuns.value.find((r) => r.id === selectedRunId.value)
  if (!r) return ''
  const s = r.stats?.stats
  if (!s) return ''
  return `收益 ${s.totalReturnPct?.toFixed(2)}%  回撤 ${s.maxDrawdownPct?.toFixed(2)}%`
})

const statItems = computed(() => {
  const s = reportData.value?.stats
  if (!s) return []
  return [
    { label: '总收益率', value: `${s.totalReturnPct?.toFixed(2)}%`, cls: s.totalReturnPct >= 0 ? 'trend-up' : 'trend-down' },
    { label: '最终净值', value: `${s.finalValue?.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} USDT`, cls: '' },
    { label: '最大回撤', value: `${s.maxDrawdownPct?.toFixed(2)}%`, cls: 'trend-down' },
    { label: '夏普率(年化)', value: s.sharpeAnnualized?.toFixed(3) ?? '-', cls: '' },
    { label: '完整交易次数', value: s.fullTradeCount ?? 0, cls: '' },
    { label: '胜率', value: `${s.winRate?.toFixed(1)}%`, cls: '' },
    { label: '胜场平均收益', value: `${s.avgWinReturnPct?.toFixed(2)}%`, cls: 'trend-up' },
    { label: '败场平均亏损', value: `${s.avgLossReturnPct?.toFixed(2)}%`, cls: 'trend-down' },
    { label: '平均持仓周期', value: `${s.avgHoldCandles?.toFixed(1)} 根`, cls: '' },
    { label: '总盈亏', value: `${s.totalPnl?.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} USDT`, cls: s.totalPnl >= 0 ? 'trend-up' : 'trend-down' },
  ]
})

const posColumns = [
  { title: '#', key: 'posNo', width: 50 },
  { title: '标的', key: 'symbol', width: 120 },
  { title: '买入时间', key: 'entryTime', width: 150 },
  { title: '买入价', key: 'entryPrice', width: 100 },
  { title: '平仓时间', key: 'closeTime', width: 150 },
  { title: '平均卖价', key: 'sellPrice', width: 100 },
  { title: '盈亏(USDT)', key: 'pnl', width: 110, render: (r: any) => r.pnl?.toFixed(2) ?? '-' },
  { title: '收益率', key: 'returnPct', width: 90, render: (r: any) => `${r.returnPct?.toFixed(2)}%` },
  { title: '持仓根数', key: 'holdCandles', width: 90 },
  { title: '出场原因', key: 'stopTypes', ellipsis: { tooltip: true }, render: (r: any) => r.stopTypes?.join(' / ') ?? '-' },
]

const symColumns = [
  { title: '标的', key: 'symbol', width: 130 },
  { title: '仓位数', key: 'posCount', width: 80 },
  { title: '胜率', key: 'winRate', width: 80, render: (r: any) => `${r.winRate}%` },
  { title: '总盈亏', key: 'totalPnl', width: 110, render: (r: any) => r.totalPnl?.toFixed(2) },
  { title: '平均收益', key: 'avgReturn', width: 90, render: (r: any) => `${r.avgReturn?.toFixed(2)}%` },
  { title: '最佳', key: 'bestReturn', width: 80, render: (r: any) => `${r.bestReturn?.toFixed(2)}%` },
  { title: '最差', key: 'worstReturn', width: 80, render: (r: any) => `${r.worstReturn?.toFixed(2)}%` },
  { title: '均持根数', key: 'avgHold', width: 80 },
]

const loadRun = async (runId: string) => {
  try {
    const full = await backtestApi.getRun(runId)
    reportData.value = full?.stats ?? null
    nextTick(() => renderChart())
  } catch (err: any) {
    message.error(err.message)
  }
}

const renderChart = () => {
  if (!chartRef.value || !reportData.value?.portfolio) return
  if (chart) chart.dispose()
  chart = echarts.init(chartRef.value)
  const { labels, values } = reportData.value.portfolio
  chart.setOption({
    ...echartsTheme.value,
    tooltip: { trigger: 'axis' },
    grid: { left: '8%', right: '4%', bottom: '12%', top: '8%' },
    xAxis: { type: 'category', data: labels, axisLabel: { rotate: 30 } },
    yAxis: { type: 'value', scale: true },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }, { type: 'slider' }],
    series: [{ name: '净值', type: 'line', data: values, smooth: false, showSymbol: false, areaStyle: { opacity: 0.2 } }],
  })
}

watch(() => props.run, async (r) => {
  if (!r) { reportData.value = null; return }
  // load full run list
  try {
    allRuns.value = await backtestApi.listRuns(props.strategy.id)
    if (allRuns.value.length) {
      selectedRunId.value = allRuns.value[0].id
      await loadRun(selectedRunId.value)
    }
  } catch { /* ignore */ }
}, { immediate: true })

onMounted(() => { window.addEventListener('resize', () => chart?.resize()) })
onUnmounted(() => { chart?.dispose(); window.removeEventListener('resize', () => chart?.resize()) })
</script>

<style scoped>
.backtest-detail { padding: 4px 0; }
.run-selector { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.run-meta { font-size: 14px; color: var(--ember-text-secondary); }
.stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px; }
.stat-item { background: var(--ember-surface); border: 1px solid var(--ember-border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.label { font-size: 12px; color: var(--ember-neutral); }
.value { font-size: 15px; font-weight: 600; color: var(--ember-text); }
.section-title { font-family: 'Source Sans 3', sans-serif; font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--ember-text); }
.chart-container { height: 300px; width: 100%; }
</style>
