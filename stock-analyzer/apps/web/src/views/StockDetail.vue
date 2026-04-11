<template>
  <div class="stock-detail">
    <el-page-header @back="$router.back()" :title="stock?.name" />
    
    <el-row :gutter="20" class="info-row">
      <el-col :span="16">
        <el-card>
          <template #header>
            <div class="chart-header">
              <span>K线图</span>
              <el-radio-group v-model="period" size="small" @change="fetchData">
                <el-radio-button label="day">日线</el-radio-button>
                <el-radio-button label="week">周线</el-radio-button>
                <el-radio-button label="month">月线</el-radio-button>
              </el-radio-group>
            </div>
          </template>
          <v-chart class="chart" :option="chartOption" autoresize />
        </el-card>
      </el-col>
      
      <el-col :span="8">
        <el-card title="基本信息">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="股票代码">{{ stock?.tsCode }}</el-descriptions-item>
            <el-descriptions-item label="股票名称">{{ stock?.name }}</el-descriptions-item>
            <el-descriptions-item label="所属行业">{{ stock?.industry }}</el-descriptions-item>
            <el-descriptions-item label="所属地区">{{ stock?.area }}</el-descriptions-item>
            <el-descriptions-item label="市场类型">{{ stock?.market }}</el-descriptions-item>
            <el-descriptions-item label="上市日期">{{ stock?.listDate }}</el-descriptions-item>
          </el-descriptions>
          
          <div class="actions">
            <el-button type="primary" @click="showAddDialog = true">
              加入自选
            </el-button>
            <el-button @click="goToBacktest">
              策略回测
            </el-button>
          </div>
        </el-card>
        
        <el-card class="indicator-card" title="最新指标">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="MA5">{{ formatNumber(latestIndicator?.ma5) }}</el-descriptions-item>
            <el-descriptions-item label="MA10">{{ formatNumber(latestIndicator?.ma10) }}</el-descriptions-item>
            <el-descriptions-item label="MA20">{{ formatNumber(latestIndicator?.ma20) }}</el-descriptions-item>
            <el-descriptions-item label="MACD">{{ formatNumber(latestIndicator?.macdDif) }}</el-descriptions-item>
            <el-descriptions-item label="KDJ-K">{{ formatNumber(latestIndicator?.kdjK) }}</el-descriptions-item>
            <el-descriptions-item label="RSI6">{{ formatNumber(latestIndicator?.rsi6) }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
    </el-row>

    <!-- 添加到自选弹窗 -->
    <el-dialog v-model="showAddDialog" title="添加到自选股" width="400px">
      <el-form>
        <el-form-item label="选择分组">
          <el-select v-model="selectedWatchlist" placeholder="请选择">
            <el-option
              v-for="wl in watchlists"
              :key="wl.id"
              :label="wl.name"
              :value="wl.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmAdd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { CandlestickChart, LineChart, BarChart } from 'echarts/charts'
import {
  GridComponent,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components'
import VChart from 'vue-echarts'
import { ElMessage } from 'element-plus'
import { stockApi, watchlistApi } from '@/api'
import type { Stock, StockPrice, Indicator } from '@/api'

use([
  CanvasRenderer,
  CandlestickChart,
  LineChart,
  BarChart,
  GridComponent,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
])

const route = useRoute()
const router = useRouter()
const tsCode = route.params.tsCode as string

const stock = ref<Stock>()
const prices = ref<StockPrice[]>([])
const indicators = ref<Indicator[]>([])
const period = ref<'day' | 'week' | 'month'>('day')
const showAddDialog = ref(false)
const watchlists = ref([])
const selectedWatchlist = ref('')

const latestIndicator = computed(() => {
  return indicators.value[indicators.value.length - 1]
})

const chartOption = computed(() => {
  const dates = prices.value.map(p => p.tradeDate)
  const data = prices.value.map(p => [p.open, p.close, p.low, p.high])
  const volumes = prices.value.map(p => p.vol)
  const ma5 = indicators.value.map(i => i.ma5)
  const ma10 = indicators.value.map(i => i.ma10)
  const ma20 = indicators.value.map(i => i.ma20)

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
    },
    legend: {
      data: ['K线', 'MA5', 'MA10', 'MA20'],
    },
    grid: [
      { left: '10%', right: '8%', height: '50%' },
      { left: '10%', right: '8%', top: '68%', height: '16%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        scale: true,
        boundaryGap: false,
        axisLine: { onZero: false },
        splitLine: { show: false },
        min: 'dataMin',
        max: 'dataMax',
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        scale: true,
        boundaryGap: false,
        axisLine: { onZero: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        min: 'dataMin',
        max: 'dataMax',
      },
    ],
    yAxis: [
      {
        scale: true,
        splitArea: { show: true },
      },
      {
        scale: true,
        gridIndex: 1,
        splitNumber: 2,
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 50, end: 100 },
      { show: true, xAxisIndex: [0, 1], type: 'slider', top: '85%', start: 50, end: 100 },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: data,
        itemStyle: {
          color: '#ef232a',
          color0: '#14b143',
          borderColor: '#ef232a',
          borderColor0: '#14b143',
        },
      },
      {
        name: 'MA5',
        type: 'line',
        data: ma5,
        smooth: true,
        lineStyle: { opacity: 0.5 },
      },
      {
        name: 'MA10',
        type: 'line',
        data: ma10,
        smooth: true,
        lineStyle: { opacity: 0.5 },
      },
      {
        name: 'MA20',
        type: 'line',
        data: ma20,
        smooth: true,
        lineStyle: { opacity: 0.5 },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
      },
    ],
  }
})

const fetchData = async () => {
  const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '')
  const startDate = '20200101'

  const [stockRes, pricesRes, indicatorsRes] = await Promise.all([
    stockApi.getStock(tsCode),
    stockApi.getPrices(tsCode, { startDate, endDate, period: period.value }),
    stockApi.getIndicators(tsCode, { startDate, endDate }),
  ])

  stock.value = stockRes.data
  prices.value = pricesRes.data
  indicators.value = indicatorsRes.data
}

const formatNumber = (val: number | undefined) => {
  return val ? val.toFixed(2) : '-'
}

const goToBacktest = () => {
  router.push({
    name: 'Backtest',
    query: { tsCode },
  })
}

const confirmAdd = async () => {
  if (!selectedWatchlist.value) {
    ElMessage.warning('请选择分组')
    return
  }
  try {
    await watchlistApi.addItem(selectedWatchlist.value, { tsCode })
    ElMessage.success('添加成功')
    showAddDialog.value = false
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '添加失败')
  }
}

onMounted(async () => {
  await fetchData()
  const { data } = await watchlistApi.getWatchlists()
  watchlists.value = data
  if (data.length > 0) {
    selectedWatchlist.value = data[0].id
  }
})
</script>

<style scoped>
.stock-detail {
  max-width: 1400px;
  margin: 0 auto;
}

.info-row {
  margin-top: 20px;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chart {
  height: 500px;
}

.actions {
  margin-top: 20px;
  display: flex;
  gap: 10px;
}

.indicator-card {
  margin-top: 20px;
}
</style>
