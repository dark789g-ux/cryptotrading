<template>
  <div class="symbols-view">
    <div class="page-header">
      <h1 class="page-title">标的筛选</h1>
      <n-space>
        <n-select v-model:value="selectedInterval" :options="intervalOptions" style="width:120px" @update:value="loadData" />
        <n-button @click="loadData" :loading="loading">
          <template #icon><n-icon><refresh-outline /></n-icon></template>
          刷新
        </n-button>
      </n-space>
    </div>

    <!-- 筛选条件 -->
    <n-card class="filter-card" :bordered="false">
      <div class="filter-row">
        <n-input v-model:value="searchQuery" placeholder="搜索标的..." clearable style="width:200px" @keyup.enter="applyFilters">
          <template #prefix><n-icon><search-outline /></n-icon></template>
        </n-input>
        <n-button @click="showFilterDrawer = true">
          <template #icon><n-icon><filter-outline /></n-icon></template>
          高级筛选
          <n-badge v-if="conditions.length" :value="conditions.length" />
        </n-button>
        <n-button @click="resetFilters">重置</n-button>
        <n-button type="primary" @click="applyFilters">应用筛选</n-button>
      </div>
      <div v-if="conditions.length" class="filter-tags">
        <n-tag v-for="(cond, i) in conditions" :key="i" closable @close="removeCondition(i)">
          {{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}
        </n-tag>
      </div>
    </n-card>

    <!-- 数据表格 -->
    <n-card class="data-card" :bordered="false">
      <n-data-table
        :columns="columns"
        :data="symbols"
        :loading="loading"
        :pagination="paginationState"
        remote
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
        @update:sorter="handleSort"
      />
    </n-card>

    <!-- 高级筛选抽屉 -->
    <n-drawer v-model:show="showFilterDrawer" placement="right" :width="400" class="glass-drawer">
      <n-drawer-content title="高级筛选" closable>
        <div class="filter-form">
          <h4>可用字段</h4>
          <n-select v-model:value="newCondition.field" :options="fieldOptions" placeholder="选择字段" />
          <h4>操作符</h4>
          <n-select v-model:value="newCondition.op" :options="opOptions" placeholder="选择操作符" />
          <h4>数值</h4>
          <n-input-number v-model:value="newCondition.value" style="width:100%" />
          <n-button type="primary" block @click="addCondition" :disabled="!canAddCondition" style="margin-top:12px">添加条件</n-button>
          <n-divider />
          <h4>当前条件</h4>
          <n-empty v-if="!conditions.length" description="暂无筛选条件" />
          <div v-else class="condition-list">
            <div v-for="(cond, i) in conditions" :key="i" class="condition-item">
              <span>{{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}</span>
              <n-button quaternary circle size="small" @click="removeCondition(i)">
                <template #icon><n-icon><close-outline /></n-icon></template>
              </n-button>
            </div>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>

    <!-- K 线图表抽屉 -->
    <n-drawer v-model:show="showChartDrawer" placement="right" :width="1000" class="glass-drawer" @after-enter="renderChart">
      <n-drawer-content :title="`${selectedSymbol} · ${selectedInterval.toUpperCase()}`" closable>
        <div ref="chartRef" class="kline-chart"></div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SymbolsView' })
import { ref, computed, onMounted, onUnmounted, h } from 'vue'
import * as echarts from 'echarts'
import {
  NButton, NIcon, NSelect, NSpace, NInput, NBadge, NTag, NTooltip,
  NCard, NDataTable, NInputNumber, NDivider, NEmpty, NDrawer, NDrawerContent,
  useMessage,
} from 'naive-ui'
import { RefreshOutline, SearchOutline, FilterOutline, CloseOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { symbolApi, klinesApi } from '../composables/useApi'
import { colors } from '../styles/tokens'
import { useTheme } from '../composables/useTheme'
import { MA_COLORS, KDJ_COLORS, CANDLE_COLORS } from '../composables/chartColors'

const message = useMessage()
const { echartsTheme } = useTheme()

const selectedInterval = ref('1h')
const intervalOptions = [{ label: '1h', value: '1h' }, { label: '4h', value: '4h' }, { label: '1d', value: '1d' }]
const loading = ref(false)
const symbols = ref<any[]>([])
const total = ref(0)
const searchQuery = ref('')
const showFilterDrawer = ref(false)
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const chartRef = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null
let klineData: any[] = []

const conditions = ref<{ field: string; op: string; value: number }[]>([])
const newCondition = ref({ field: '', op: 'gt', value: 0 })
const fieldOptions = ref<{ label: string; value: string }[]>([])
const opOptions = [
  { label: '大于', value: 'gt' }, { label: '小于', value: 'lt' },
  { label: '大于等于', value: 'gte' }, { label: '小于等于', value: 'lte' },
]
const opLabels: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' }
const canAddCondition = computed(() => !!newCondition.value.field)

const sortKey = ref<string | null>(null)
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const page = ref(1)
const pageSize = ref(20)
const paginationState = computed(() => ({
  page: page.value, pageSize: pageSize.value, itemCount: total.value,
  showSizePicker: true, pageSizes: [10, 20, 50],
  prefix: () => `共 ${total.value} 条`,
}))

const columns = computed(() => [
  { title: '标的', key: 'symbol', width: 120, fixed: 'left' as const, sorter: true },
  { title: '收盘价', key: 'close', width: 110, sorter: true, render: (r: any) => Number(r.close).toPrecision(6) },
  { title: 'MA5', key: 'ma5', width: 110, sorter: true, render: (r: any) => r.ma5?.toFixed(4) ?? '-' },
  { title: 'MA30', key: 'ma30', width: 110, sorter: true, render: (r: any) => r.ma30?.toFixed(4) ?? '-' },
  { title: 'MA60', key: 'ma60', width: 110, sorter: true, render: (r: any) => r.ma60?.toFixed(4) ?? '-' },
  { title: 'KDJ.J', key: 'kdjJ', width: 90, sorter: true, render: (r: any) => r.kdjJ?.toFixed(2) ?? '-' },
  { title: '盈亏比', key: 'riskRewardRatio', width: 90, sorter: true, render: (r: any) => r.riskRewardRatio?.toFixed(2) ?? '-' },
  { title: '止损%', key: 'stopLossPct', width: 90, sorter: true, render: (r: any) => r.stopLossPct ? `${r.stopLossPct.toFixed(2)}%` : '-' },
  { title: '最新更新', key: 'openTime', width: 110, sorter: true, render: (r: any) => r.openTime ? new Date(r.openTime).toISOString().slice(0, 10) : '-' },
  {
    title: '操作', key: 'actions', width: 70, fixed: 'right' as const,
    render: (r: any) => h(NTooltip, null, {
      trigger: () => h(NButton, { size: 'small', onClick: () => openChart(r.symbol) },
        { icon: () => h(NIcon, null, () => h(TrendingUpOutline)) }),
      default: () => 'K线',
    }),
  },
])

const buildQuery = () => ({
  interval: selectedInterval.value,
  q: searchQuery.value,
  conditions: conditions.value,
  sort: { field: sortKey.value ?? 'symbol', asc: sortOrder.value !== 'descend' },
  page: page.value,
  page_size: pageSize.value,
})

const loadData = async () => {
  loading.value = true
  try {
    const res = await symbolApi.query(buildQuery())
    symbols.value = res.items
    total.value = res.total
  } catch (err: any) {
    message.error(err.message)
  } finally {
    loading.value = false
  }
}

const loadFields = async () => {
  try {
    const cols = await symbolApi.getKlineColumns()
    fieldOptions.value = cols.map((c) => ({ label: c, value: c }))
  } catch { /* ignore */ }
}

const applyFilters = () => { page.value = 1; loadData() }
const resetFilters = () => { conditions.value = []; searchQuery.value = ''; page.value = 1; loadData() }
const addCondition = () => {
  if (!canAddCondition.value) return
  conditions.value.push({ ...newCondition.value })
  newCondition.value = { field: '', op: 'gt', value: 0 }
}
const removeCondition = (i: number) => { conditions.value.splice(i, 1); applyFilters() }

const handlePageChange = (p: number) => { page.value = p; loadData() }
const handlePageSizeChange = (s: number) => { pageSize.value = s; page.value = 1; loadData() }
const handleSort = (s: any) => {
  sortKey.value = s?.columnKey ?? null
  sortOrder.value = s?.order ?? null
  loadData()
}

const openChart = async (symbol: string) => {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  try {
    klineData = await klinesApi.getKlines(symbol, selectedInterval.value)
  } catch (err: any) { message.error(err.message) }
}

const ARROW_RICH = {
  up: { color: CANDLE_COLORS.up, fontSize: 12 },
  down: { color: CANDLE_COLORS.down, fontSize: 12 },
  eq: { color: CANDLE_COLORS.eq, fontSize: 12 },
}

const fmt = (v: any, d = 4) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(d))

const arrow = (cur: any, prev: any): { sym: string; key: 'up' | 'down' | 'eq' } => {
  const c = Number(cur), p = Number(prev)
  if (!Number.isFinite(c) || !Number.isFinite(p)) return { sym: '-', key: 'eq' }
  if (c > p) return { sym: '▲', key: 'up' }
  if (c < p) return { sym: '▼', key: 'down' }
  return { sym: '-', key: 'eq' }
}

const buildMaText = (idx: number) => {
  const r = klineData[idx] || {}
  const prev = klineData[idx - 1] || {}
  const keys: (keyof typeof MA_COLORS)[] = ['MA5', 'MA30', 'MA60', 'MA120', 'MA240']
  const segs = keys.map((k) => {
    const a = arrow(r[k], prev[k])
    const tag = k.toLowerCase()
    return `${k}: {${tag}|${fmt(r[k])}}{${a.key}|${a.sym}}`
  })
  const rich: Record<string, any> = { ...ARROW_RICH }
  keys.forEach((k) => { rich[k.toLowerCase()] = { color: MA_COLORS[k], fontSize: 12 } })
  return { text: segs.join('  '), rich }
}

const buildKdjText = (idx: number) => {
  const r = klineData[idx] || {}
  const prev = klineData[idx - 1] || {}
  const keys: (keyof typeof KDJ_COLORS)[] = ['KDJ.K', 'KDJ.D', 'KDJ.J']
  const labels: Record<string, string> = { 'KDJ.K': 'K', 'KDJ.D': 'D', 'KDJ.J': 'J' }
  const tagMap: Record<string, string> = { 'KDJ.K': 'k', 'KDJ.D': 'd', 'KDJ.J': 'j' }
  const segs = keys.map((k) => {
    const a = arrow(r[k], prev[k])
    return `${labels[k]}: {${tagMap[k]}|${fmt(r[k], 2)}}{${a.key}|${a.sym}}`
  })
  const rich: Record<string, any> = { ...ARROW_RICH }
  keys.forEach((k) => { rich[tagMap[k]] = { color: KDJ_COLORS[k], fontSize: 12 } })
  return { text: segs.join('  '), rich }
}

const renderChart = () => {
  if (!chartRef.value || !klineData.length) return
  if (chart) chart.dispose()
  chart = echarts.init(chartRef.value)
  const upColor = CANDLE_COLORS.up; const downColor = CANDLE_COLORS.down
  const times = klineData.map((d) => d.open_time)
  const klines = klineData.map((d) => [d.open, d.close, d.low, d.high])
  const lastIdx = klineData.length - 1

  chart.setOption({
    ...echartsTheme.value,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      confine: true,
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params.find((x: any) => x.seriesType === 'candlestick') : null
        if (!p) return ''
        const idx = p.dataIndex as number
        const row = klineData[idx] || {}
        const o = Number(row.open), h = Number(row.high), l = Number(row.low), c = Number(row.close)
        const prev = idx > 0 ? Number(klineData[idx - 1].close) : c
        const diff = c - prev
        const pct = prev ? (diff / prev) * 100 : 0
        const color = diff >= 0 ? CANDLE_COLORS.up : CANDLE_COLORS.down
        const sign = diff >= 0 ? '+' : ''
        return `
          <div style="font-size:12px;line-height:1.6">
            <div style="margin-bottom:4px;color:${colors.text.muted}">${row.open_time ?? ''}</div>
            <div>开: ${fmt(o, 4)}</div>
            <div>高: ${fmt(h, 4)}</div>
            <div>低: ${fmt(l, 4)}</div>
            <div>收: ${fmt(c, 4)}</div>
            <div style="color:${color}">涨跌: ${sign}${fmt(diff, 4)} (${sign}${pct.toFixed(2)}%)</div>
          </div>
        `
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: [
      {
        orient: 'vertical', right: 12, top: '8%',
        data: ['K线', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240'],
        textStyle: { fontSize: 11 }, itemWidth: 14, itemHeight: 8,
      },
      {
        orient: 'vertical', right: 12, top: '70%',
        data: ['KDJ.K', 'KDJ.D', 'KDJ.J'],
        textStyle: { fontSize: 11 }, itemWidth: 14, itemHeight: 8,
      },
    ],
    grid: [{ left: '8%', right: '8%', top: '10%', height: '55%' }, { left: '8%', right: '8%', top: '72%', height: '20%' }],
    xAxis: [
      { type: 'category', data: times, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 1, axisLabel: { show: false }, axisPointer: { label: { show: true } } },
    ],
    yAxis: [
      { scale: true, axisPointer: { label: { show: false } } },
      { scale: true, gridIndex: 1, axisPointer: { label: { show: false } } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 70, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], start: 70, end: 100, bottom: '1%' },
    ],
    graphic: [
      { id: 'ma-values', type: 'text', left: '9%', top: '10%', z: 100, style: buildMaText(lastIdx) },
      { id: 'kdj-values', type: 'text', left: '9%', top: '72%', z: 100, style: buildKdjText(lastIdx) },
    ],
    series: [
      { name: 'K线', type: 'candlestick', data: klines, itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor } },
      { name: 'MA5', type: 'line', data: klineData.map((d) => d.MA5), showSymbol: false, lineStyle: { width: 1, color: MA_COLORS.MA5 }, itemStyle: { color: MA_COLORS.MA5 } },
      { name: 'MA30', type: 'line', data: klineData.map((d) => d.MA30), showSymbol: false, lineStyle: { width: 1, color: MA_COLORS.MA30 }, itemStyle: { color: MA_COLORS.MA30 } },
      { name: 'MA60', type: 'line', data: klineData.map((d) => d.MA60), showSymbol: false, lineStyle: { width: 1, color: MA_COLORS.MA60 }, itemStyle: { color: MA_COLORS.MA60 } },
      { name: 'MA120', type: 'line', data: klineData.map((d) => d.MA120), showSymbol: false, lineStyle: { width: 1, color: MA_COLORS.MA120 }, itemStyle: { color: MA_COLORS.MA120 } },
      { name: 'MA240', type: 'line', data: klineData.map((d) => d.MA240), showSymbol: false, lineStyle: { width: 1, color: MA_COLORS.MA240 }, itemStyle: { color: MA_COLORS.MA240 } },
      { name: 'KDJ.K', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: klineData.map((d) => d['KDJ.K']), showSymbol: false, lineStyle: { width: 1, color: KDJ_COLORS['KDJ.K'] }, itemStyle: { color: KDJ_COLORS['KDJ.K'] } },
      { name: 'KDJ.D', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: klineData.map((d) => d['KDJ.D']), showSymbol: false, lineStyle: { width: 1, color: KDJ_COLORS['KDJ.D'] }, itemStyle: { color: KDJ_COLORS['KDJ.D'] } },
      { name: 'KDJ.J', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: klineData.map((d) => d['KDJ.J']), showSymbol: false, lineStyle: { width: 1, color: KDJ_COLORS['KDJ.J'] }, itemStyle: { color: KDJ_COLORS['KDJ.J'] } },
    ],
  })

  chart.on('updateAxisPointer', (ev: any) => {
    const info = ev?.axesInfo?.find((a: any) => a.axisDim === 'x')
    const idx = typeof info?.value === 'number' ? info.value : lastIdx
    const safeIdx = idx >= 0 && idx < klineData.length ? idx : lastIdx
    chart?.setOption({
      graphic: [
        { id: 'ma-values', style: buildMaText(safeIdx) },
        { id: 'kdj-values', style: buildKdjText(safeIdx) },
      ],
    })
  })
}

onMounted(() => { loadFields(); loadData(); window.addEventListener('resize', () => chart?.resize()) })
onUnmounted(() => { chart?.dispose(); window.removeEventListener('resize', () => chart?.resize()) })
</script>

<style scoped>
.symbols-view { max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-title { font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 28px; font-weight: 700; letter-spacing: -0.01em; color: var(--ember-text); margin: 0; }
.filter-card { margin-bottom: 20px; }
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.data-card { background: var(--ember-surface); }
.filter-form h4 { margin: 16px 0 8px; font-size: 14px; font-weight: 600; color: var(--ember-text-secondary); }
.condition-list { display: flex; flex-direction: column; gap: 8px; }
.condition-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--ember-surface-hover); border-radius: 8px; }
.kline-chart { height: 700px; width: 100%; }
</style>
