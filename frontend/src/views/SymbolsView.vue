<template>
  <div class="symbols-view">
    <!-- 页面标题 -->
    <div class="page-header">
      <h1 class="page-title">标的筛选</h1>
      <n-space>
        <n-select
          v-model:value="selectedInterval"
          :options="intervalOptions"
          style="width: 120px"
          @update:value="handleIntervalChange"
        />
        <n-button @click="refreshData" :loading="loading">
          <template #icon><n-icon><refresh-outline /></n-icon></template>
          刷新
        </n-button>
      </n-space>
    </div>

    <!-- 筛选条件 -->
    <n-card class="filter-card" :bordered="false">
      <div class="filter-row">
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索标的..."
          clearable
          style="width: 200px"
          @keyup.enter="applyFilters"
        >
          <template #prefix><n-icon><search-outline /></n-icon></template>
        </n-input>
        
        <n-button @click="showFilterDrawer = true">
          <template #icon><n-icon><filter-outline /></n-icon></template>
          高级筛选
          <n-badge v-if="activeFilterCount > 0" :value="activeFilterCount" />
        </n-button>
        
        <n-button @click="resetFilters">重置</n-button>
        <n-button type="primary" @click="applyFilters">应用筛选</n-button>
      </div>
      
      <!-- 已应用的筛选标签 -->
      <div v-if="conditions.length > 0" class="filter-tags">
        <n-tag
          v-for="(cond, i) in conditions"
          :key="i"
          closable
          @close="removeCondition(i)"
        >
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
        :pagination="pagination"
        :row-key="row => row.symbol"
        remote
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
        @update:sorter="handleSort"
      />
    </n-card>

    <!-- 高级筛选抽屉 -->
    <n-drawer
      v-model:show="showFilterDrawer"
      placement="right"
      :width="400"
      class="glass-drawer"
    >
      <n-drawer-content title="高级筛选" closable>
        <div class="filter-form">
          <div class="available-fields">
            <h4>可用字段</h4>
            <n-select
              v-model:value="newCondition.field"
              :options="fieldOptions"
              placeholder="选择字段"
            />
          </div>
          
          <div class="condition-op">
            <h4>操作符</h4>
            <n-select
              v-model:value="newCondition.op"
              :options="opOptions"
              placeholder="选择操作符"
            />
          </div>
          
          <div class="condition-value">
            <h4>数值</h4>
            <n-input-number v-model:value="newCondition.value" style="width: 100%" />
          </div>
          
          <n-button type="primary" block @click="addCondition" :disabled="!canAddCondition">
            添加条件
          </n-button>
          
          <n-divider />
          
          <div class="current-conditions">
            <h4>当前条件</h4>
            <n-empty v-if="conditions.length === 0" description="暂无筛选条件" />
            <div v-else class="condition-list">
              <div
                v-for="(cond, i) in conditions"
                :key="i"
                class="condition-item"
              >
                <span>{{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}</span>
                <n-button quaternary circle size="small" @click="removeCondition(i)">
                  <template #icon><n-icon><close-outline /></n-icon></template>
                </n-button>
              </div>
            </div>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>

    <!-- K 线图表抽屉 -->
    <n-drawer
      v-model:show="showChartDrawer"
      placement="right"
      :width="1000"
      class="glass-drawer"
    >
      <n-drawer-content :title="`${selectedSymbol} - ${selectedInterval.toUpperCase()}`" closable>
        <div ref="chartRef" class="kline-chart"></div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick, onUnmounted, h } from 'vue'
import * as echarts from 'echarts'
import {
  NCard, NSpace, NButton, NInput, NSelect, NDataTable, NDrawer, NDrawerContent,
  NInputNumber, NDivider, NTag, NBadge, NEmpty, NIcon
} from 'naive-ui'
import { RefreshOutline, SearchOutline, FilterOutline, CloseOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { symbolApi } from '../composables/useApi.js'
import { useTheme } from '../composables/useTheme.js'

const { isDark, echartsTheme } = useTheme()

// 状态
const loading = ref(false)
const symbols = ref([])
const total = ref(0)
const searchQuery = ref('')
const selectedInterval = ref('1d')
const showFilterDrawer = ref(false)
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const chartRef = ref(null)
let chart = null

// 分页
const pagination = ref({
  page: 1,
  pageSize: 20,
  pageSizes: [20, 50, 100],
  showSizePicker: true,
  showQuickJumper: true,
  itemCount: 0,
  prefix: () => `共 ${total.value} 条`
})

// 排序
const sortField = ref('symbol')
const sortAsc = ref(true)

// 筛选条件
const conditions = ref([])
const availableFields = ref([])

const newCondition = ref({
  field: null,
  op: 'gt',
  value: null
})

// 操作符选项
const opOptions = [
  { label: '大于', value: 'gt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于', value: 'lt' },
  { label: '小于等于', value: 'lte' },
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'neq' }
]

const opLabels = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠'
}

// 时间周期选项
const intervalOptions = [
  { label: '1小时', value: '1h' },
  { label: '4小时', value: '4h' },
  { label: '日线', value: '1d' }
]

// 字段选项
const fieldOptions = computed(() => 
  availableFields.value.map(f => ({ label: f, value: f }))
)

const canAddCondition = computed(() => 
  newCondition.value.field && newCondition.value.value !== null
)

const activeFilterCount = computed(() => conditions.value.length)

// 表格列（动态生成）
const columns = computed(() => {
  const cols = [
    {
      title: '标的',
      key: 'symbol',
      width: 120,
      fixed: 'left',
      sorter: true
    }
  ]
  
  // 添加其他字段列（限制数量避免太宽）
  const displayFields = availableFields.value.slice(0, 8)
  displayFields.forEach(field => {
    cols.push({
      title: field,
      key: field,
      width: 110,
      sorter: true,
      ellipsis: { tooltip: true },
      render(row) {
        const val = row[field]
        if (val === null || val === undefined) return '-'
        return val.toFixed(4)
      }
    })
  })
  
  // 操作列
  cols.push({
    title: '操作',
    key: 'actions',
    width: 100,
    fixed: 'right',
    render: (row) => {
      return h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, {
            size: 'small',
            type: 'primary',
            onClick: () => showKlineChart(row.symbol)
          }, {
            icon: () => h(NIcon, null, { default: () => h(TrendingUpOutline) }),
            default: () => 'K线'
          })
        ]
      })
    }
  })
  
  return cols
})

// 加载数据
const loadData = async () => {
  loading.value = true
  try {
    const res = await fetch('/api/symbols/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interval: selectedInterval.value,
        page: pagination.value.page,
        page_size: pagination.value.pageSize,
        sort: { field: sortField.value, asc: sortAsc.value },
        q: searchQuery.value,
        conditions: conditions.value,
        fields: availableFields.value.slice(0, 10) // 限制字段数量
      })
    }).then(r => r.json())
    
    symbols.value = res.items
    total.value = res.total
    pagination.value.itemCount = res.total
  } catch (err) {
    console.error('加载数据失败:', err)
  } finally {
    loading.value = false
  }
}

// 加载可用字段
const loadFields = async () => {
  try {
    const res = await fetch(`/api/symbols/kline-columns?interval=${selectedInterval.value}`)
    availableFields.value = await res.json()
  } catch (err) {
    console.error('加载字段失败:', err)
  }
}

// 筛选操作
const addCondition = () => {
  if (!canAddCondition.value) return
  conditions.value.push({ ...newCondition.value })
  newCondition.value = { field: null, op: 'gt', value: null }
}

const removeCondition = (index) => {
  conditions.value.splice(index, 1)
}

const applyFilters = () => {
  pagination.value.page = 1
  loadData()
}

const resetFilters = () => {
  searchQuery.value = ''
  conditions.value = []
  pagination.value.page = 1
  loadData()
}

// 分页/排序
const handlePageChange = (page) => {
  pagination.value.page = page
  loadData()
}

const handlePageSizeChange = (size) => {
  pagination.value.pageSize = size
  pagination.value.page = 1
  loadData()
}

const handleSort = (sorter) => {
  sortField.value = sorter.columnKey || 'symbol'
  sortAsc.value = sorter.order !== 'descend'
  loadData()
}

const handleIntervalChange = () => {
  pagination.value.page = 1
  loadFields()
  loadData()
}

const refreshData = () => {
  loadData()
}

// 格式化日期（支持时间戳或字符串）
const formatDate = (timestamp, interval) => {
  let date
  if (typeof timestamp === 'string') {
    // 字符串日期格式：2024-01-01 08:00:00
    date = new Date(timestamp.replace(' ', 'T'))
  } else if (typeof timestamp === 'number') {
    // 时间戳（毫秒或秒）
    date = new Date(timestamp > 1e10 ? timestamp : timestamp * 1000)
  } else {
    date = new Date(timestamp)
  }
  
  if (isNaN(date.getTime())) {
    return String(timestamp).slice(0, 16) // 如果解析失败，返回原字符串前16位
  }
  
  if (interval === '1d') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  } else {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
  }
}

// 获取趋势箭头
const getTrendArrow = (current, prev) => {
  if (current > prev) return '↑'
  if (current < prev) return '↓'
  return '-'
}

// 更新左上角指标显示
const updateIndicatorLabels = (chart, data, dataIndex, isDark) => {
  const d = data[dataIndex]
  const prev = dataIndex > 0 ? data[dataIndex - 1] : d
  const textColor = isDark ? '#e0e0e0' : '#333'
  
  // MA指标
  const maTexts = [
    `MA5: ${d.MA5?.toFixed(4) || '-'} ${getTrendArrow(d.MA5, prev.MA5)}  MA30: ${d.MA30?.toFixed(4) || '-'} ${getTrendArrow(d.MA30, prev.MA30)}`,
    `MA60: ${d.MA60?.toFixed(4) || '-'} ${getTrendArrow(d.MA60, prev.MA60)}  MA120: ${d.MA120?.toFixed(4) || '-'} ${getTrendArrow(d.MA120, prev.MA120)}`,
    `MA240: ${d.MA240?.toFixed(4) || '-'} ${getTrendArrow(d.MA240, prev.MA240)}`
  ]
  
  // KDJ指标
  const kdjText = `K: ${d['KDJ.K']?.toFixed(2) || '-'} ${getTrendArrow(d['KDJ.K'], prev['KDJ.K'])}  D: ${d['KDJ.D']?.toFixed(2) || '-'} ${getTrendArrow(d['KDJ.D'], prev['KDJ.D'])}  J: ${d['KDJ.J']?.toFixed(2) || '-'} ${getTrendArrow(d['KDJ.J'], prev['KDJ.J'])}`
  
  // MACD指标
  const macdText = `DIF: ${d.DIF?.toFixed(4) || '-'} ${getTrendArrow(d.DIF, prev.DIF)}  DEA: ${d.DEA?.toFixed(4) || '-'} ${getTrendArrow(d.DEA, prev.DEA)}  MACD: ${d.MACD?.toFixed(4) || '-'} ${getTrendArrow(d.MACD, prev.MACD)}`
  
  chart.setOption({
    graphic: [
      { type: 'group', left: '10%', top: '7%', children: maTexts.map((t, i) => ({ type: 'text', top: i * 14, style: { text: t, fill: textColor, fontSize: 11 } })) },
      { type: 'group', left: '10%', top: '53%', children: [{ type: 'text', style: { text: kdjText, fill: textColor, fontSize: 11 } }] },
      { type: 'group', left: '10%', top: '74%', children: [{ type: 'text', style: { text: macdText, fill: textColor, fontSize: 11 } }] }
    ]
  })
}

// K 线图
const showKlineChart = async (symbol) => {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  
  await nextTick()
  
  if (chart) {
    chart.dispose()
  }
  
  try {
    const csvText = await symbolApi.getKlines(symbol, selectedInterval.value)
    const lines = csvText.trim().split('\n')
    const headers = lines[0].split(',')
    
    // 解析数据
    const data = lines.slice(1).map(line => {
      const cols = line.split(',')
      const row = {}
      headers.forEach((h, i) => {
        row[h] = isNaN(Number(cols[i])) ? cols[i] : parseFloat(cols[i])
      })
      return row
    })
    
    // 格式化时间（保持原始时间字符串用于tooltip）
    const rawTimes = data.map(d => d.open_time || d.time)
    const times = rawTimes.map(t => formatDate(t, selectedInterval.value))
    // K线数据格式：[open, close, low, high] 对应 ECharts candlestick
    const klineData = data.map(d => [d.open, d.close, d.low, d.high])
    
    // 准备MA数据
    const maData = {
      MA5: data.map(d => d.MA5),
      MA30: data.map(d => d.MA30),
      MA60: data.map(d => d.MA60),
      MA120: data.map(d => d.MA120),
      MA240: data.map(d => d.MA240)
    }
    
    // 准备KDJ数据
    const kdjData = {
      K: data.map(d => d['KDJ.K']),
      D: data.map(d => d['KDJ.D']),
      J: data.map(d => d['KDJ.J'])
    }
    
    // 准备MACD数据（带实心/空心判断）
    const macdData = data.map((d, i) => {
      const prev = i > 0 ? data[i - 1].MACD : d.MACD
      return {
        value: d.MACD,
        solid: d.MACD > prev
      }
    })
    
    chart = echarts.init(chartRef.value)
    
    const upColor = isDark.value ? '#ef4444' : '#ef4444'
    const downColor = isDark.value ? '#10b981' : '#10b981'
    
    const option = {
      ...echartsTheme.value,
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params) => {
          // 获取K线索引
          const klineParam = params.find(p => p.seriesName === 'K线')
          if (!klineParam) return ''
          
          const dataIndex = klineParam.dataIndex
          // 直接用我们解析的原始行，不依赖 ECharts 的 params.data 格式
          const row = data[dataIndex]
          if (!row) return ''
          const o = row.open
          const c = row.close
          const l = row.low
          const h = row.high

          // 涨跌 = 收 - 前收
          const prevC = dataIndex > 0 ? data[dataIndex - 1].close : null
          const change = prevC != null ? c - prevC : null
          const changePct = prevC != null && prevC !== 0 ? (c - prevC) / prevC * 100 : null
          const changeColor = change == null ? '#888' : change >= 0 ? upColor : downColor
          const changeSign = v => v >= 0 ? '+' : ''

          const fd = v => v != null ? (+v).toFixed(Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 4 : 6) : '-'

          // 垂直布局
          return `
            <div style="font-family: monospace; line-height: 1.6;">
              <div><b>${times[dataIndex]}</b></div>
              <div>开: ${fd(o)}</div>
              <div>高: ${fd(h)}</div>
              <div>低: ${fd(l)}</div>
              <div>收: ${fd(c)}</div>
              ${change != null ? `<div style="color: ${changeColor}">涨跌: ${changeSign(change)}${fd(change)}</div>` : ''}
              ${changePct != null ? `<div style="color: ${changeColor}">涨幅: ${changeSign(changePct)}${changePct.toFixed(2)}%</div>` : ''}
            </div>
          `
        }
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: isDark.value ? '#333' : '#fff' }
      },
      grid: [
        { left: '8%', right: '8%', top: '12%', height: '38%' },
        { left: '8%', right: '8%', top: '55%', height: '16%' },
        { left: '8%', right: '8%', top: '76%', height: '16%' }
      ],
      xAxis: [
        { type: 'category', data: rawTimes, scale: true, axisLine: { onZero: false }, axisLabel: { show: false } },
        { type: 'category', data: rawTimes, gridIndex: 1, scale: true, axisLine: { onZero: false }, axisLabel: { show: false } },
        { type: 'category', data: rawTimes, gridIndex: 2, scale: true, axisLine: { onZero: false }, axisLabel: { show: false } }
      ],
      yAxis: [
        { scale: true, splitArea: { show: false } },
        { scale: true, gridIndex: 1, splitArea: { show: false } },
        { scale: true, gridIndex: 2, splitArea: { show: false } }
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: 80, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, 2], start: 80, end: 100, bottom: '1%' }
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          data: klineData,
          itemStyle: {
            color: upColor,
            color0: downColor,
            borderColor: upColor,
            borderColor0: downColor
          }
        },
        { name: 'MA5', type: 'line', data: maData.MA5, smooth: false, showSymbol: false, lineStyle: { width: 1 } },
        { name: 'MA30', type: 'line', data: maData.MA30, smooth: false, showSymbol: false, lineStyle: { width: 1 } },
        { name: 'MA60', type: 'line', data: maData.MA60, smooth: false, showSymbol: false, lineStyle: { width: 1 } },
        { name: 'MA120', type: 'line', data: maData.MA120, smooth: false, showSymbol: false, lineStyle: { width: 1 } },
        { name: 'MA240', type: 'line', data: maData.MA240, smooth: false, showSymbol: false, lineStyle: { width: 1 } },
        { name: 'KDJ.K', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: kdjData.K, smooth: false, showSymbol: false, lineStyle: { width: 1.5 } },
        { name: 'KDJ.D', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: kdjData.D, smooth: false, showSymbol: false, lineStyle: { width: 1.5 } },
        { name: 'KDJ.J', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: kdjData.J, smooth: false, showSymbol: false, lineStyle: { width: 1.5 } },
        { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: data.map(d => d.DIF), smooth: false, showSymbol: false, lineStyle: { width: 1.5 } },
        { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: data.map(d => d.DEA), smooth: false, showSymbol: false, lineStyle: { width: 1.5 } },
        { 
          name: 'MACD', 
          type: 'bar', 
          xAxisIndex: 2, 
          yAxisIndex: 2, 
          data: macdData.map(d => ({
            value: d.value,
            itemStyle: {
              color: d.solid 
                ? (d.value >= 0 ? upColor : downColor)
                : 'transparent',
              borderColor: d.value >= 0 ? upColor : downColor,
              borderWidth: 1
            }
          }))
        }
      ]
    }
    
    chart.setOption(option)
    
    // 初始化左上角指标显示（最后一根K线）
    updateIndicatorLabels(chart, data, data.length - 1, isDark.value)
    
    // 监听十字线移动，更新左上角指标
    chart.on('updateAxisPointer', (event) => {
      const xAxisInfo = event.axesInfo?.[0]
      if (xAxisInfo) {
        const dataIndex = xAxisInfo.value
        if (dataIndex >= 0 && dataIndex < data.length) {
          updateIndicatorLabels(chart, data, dataIndex, isDark.value)
        }
      }
    })
    
  } catch (err) {
    console.error('加载K线数据失败:', err)
  }
}

onMounted(() => {
  loadFields()
  loadData()
  window.addEventListener('resize', () => chart?.resize())
})

onUnmounted(() => {
  chart?.dispose()
  window.removeEventListener('resize', () => chart?.resize())
})
</script>

<style scoped>
.symbols-view {
  max-width: 1400px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.filter-card {
  margin-bottom: 20px;
}

.filter-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.filter-tags {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.data-card {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
}

.filter-form h4 {
  margin: 16px 0 8px;
  font-size: 14px;
  color: var(--text-secondary);
}

.condition-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.condition-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-hover);
  border-radius: 8px;
}

.kline-chart {
  height: 700px;
  width: 100%;
}
</style>
