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
import { ref, computed, onMounted, onUnmounted, h } from 'vue'
import * as echarts from 'echarts'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { RefreshOutline, SearchOutline, FilterOutline, CloseOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { symbolApi, klinesApi } from '../composables/useApi'
import { useTheme } from '../composables/useTheme'

const message = useMessage()
const { echartsTheme, isDark } = useTheme()

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
  { title: '标的', key: 'symbol', width: 120, fixed: 'left', sorter: true },
  { title: '收盘价', key: 'close', width: 110, sorter: true, render: (r: any) => Number(r.close).toPrecision(6) },
  { title: 'MA5', key: 'ma5', width: 110, sorter: true, render: (r: any) => r.ma5?.toFixed(4) ?? '-' },
  { title: 'MA30', key: 'ma30', width: 110, sorter: true, render: (r: any) => r.ma30?.toFixed(4) ?? '-' },
  { title: 'MA60', key: 'ma60', width: 110, sorter: true, render: (r: any) => r.ma60?.toFixed(4) ?? '-' },
  { title: 'KDJ.J', key: 'kdjJ', width: 90, sorter: true, render: (r: any) => r.kdjJ?.toFixed(2) ?? '-' },
  { title: '盈亏比', key: 'riskRewardRatio', width: 90, sorter: true, render: (r: any) => r.riskRewardRatio?.toFixed(2) ?? '-' },
  { title: '止损%', key: 'stopLossPct', width: 90, sorter: true, render: (r: any) => r.stopLossPct ? `${r.stopLossPct.toFixed(2)}%` : '-' },
  {
    title: '操作', key: 'actions', width: 100, fixed: 'right',
    render: (r: any) => h(NButton, { size: 'small', quaternary: true, onClick: () => openChart(r.symbol) },
      { icon: () => h(NIcon, null, () => h(TrendingUpOutline)), default: () => 'K线' }),
  },
])

const buildQuery = () => ({
  interval: selectedInterval.value,
  search: searchQuery.value,
  conditions: conditions.value,
  sortKey: sortKey.value,
  sortOrder: sortOrder.value,
  page: page.value,
  pageSize: pageSize.value,
})

const loadData = async () => {
  loading.value = true
  try {
    const res = await symbolApi.query(buildQuery())
    symbols.value = res.data
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

const renderChart = () => {
  if (!chartRef.value || !klineData.length) return
  if (chart) chart.dispose()
  chart = echarts.init(chartRef.value)
  const upColor = '#ef5350'; const downColor = '#26a69a'
  const times = klineData.map((d) => d.open_time)
  const klines = klineData.map((d) => [d.open, d.close, d.low, d.high])
  chart.setOption({
    ...echartsTheme.value,
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    grid: [{ left: '8%', right: '8%', top: '8%', height: '55%' }, { left: '8%', right: '8%', top: '70%', height: '20%' }],
    xAxis: [
      { type: 'category', data: times, axisLabel: { show: false } },
      { type: 'category', data: times, gridIndex: 1, axisLabel: { show: false } },
    ],
    yAxis: [{ scale: true }, { scale: true, gridIndex: 1 }],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 70, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], start: 70, end: 100, bottom: '1%' },
    ],
    series: [
      { name: 'K线', type: 'candlestick', data: klines, itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor } },
      { name: 'MA5', type: 'line', data: klineData.map((d) => d.MA5), showSymbol: false, lineStyle: { width: 1 } },
      { name: 'MA30', type: 'line', data: klineData.map((d) => d.MA30), showSymbol: false, lineStyle: { width: 1 } },
      { name: 'KDJ.J', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: klineData.map((d) => d['KDJ.J']), showSymbol: false, lineStyle: { width: 1.5 } },
    ],
  })
}

onMounted(() => { loadFields(); loadData(); window.addEventListener('resize', () => chart?.resize()) })
onUnmounted(() => { chart?.dispose(); window.removeEventListener('resize', () => chart?.resize()) })
</script>

<style scoped>
.symbols-view { max-width: 1400px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-title { font-size: 24px; font-weight: 600; color: var(--text-primary); margin: 0; }
.filter-card { margin-bottom: 20px; }
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.data-card { background: var(--glass-bg); backdrop-filter: var(--glass-blur); }
.filter-form h4 { margin: 16px 0 8px; font-size: 14px; color: var(--text-secondary); }
.condition-list { display: flex; flex-direction: column; gap: 8px; }
.condition-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg-hover); border-radius: 8px; }
.kline-chart { height: 700px; width: 100%; }
</style>
