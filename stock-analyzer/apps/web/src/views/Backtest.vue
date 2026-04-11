<template>
  <div class="backtest">
    <el-row :gutter="20">
      <el-col :span="8">
        <el-card title="回测参数">
          <el-form :model="form" label-width="100px">
            <el-form-item label="股票代码" required>
              <el-input v-model="form.tsCode" placeholder="如: 000001.SZ">
                <template #append>
                  <el-button @click="searchStock">
                    <el-icon><Search /></el-icon>
                  </el-button>
                </template>
              </el-input>
            </el-form-item>
            
            <el-form-item label="开始日期" required>
              <el-date-picker
                v-model="form.startDate"
                type="date"
                placeholder="选择开始日期"
                value-format="YYYYMMDD"
              />
            </el-form-item>
            
            <el-form-item label="结束日期" required>
              <el-date-picker
                v-model="form.endDate"
                type="date"
                placeholder="选择结束日期"
                value-format="YYYYMMDD"
              />
            </el-form-item>
            
            <el-form-item label="初始资金" required>
              <el-input-number
                v-model="form.initialCapital"
                :min="10000"
                :step="10000"
                style="width: 100%"
              />
            </el-form-item>
            
            <el-form-item label="策略" required>
              <el-select v-model="form.strategy" style="width: 100%">
                <el-option label="双均线策略" value="ma_cross" />
              </el-select>
            </el-form-item>
            
            <template v-if="form.strategy === 'ma_cross'">
              <el-form-item label="短期均线">
                <el-select v-model="form.params.maShort">
                  <el-option label="MA5" :value="5" />
                  <el-option label="MA10" :value="10" />
                </el-select>
              </el-form-item>
              
              <el-form-item label="长期均线">
                <el-select v-model="form.params.maLong">
                  <el-option label="MA20" :value="20" />
                  <el-option label="MA60" :value="60" />
                </el-select>
              </el-form-item>
            </template>
            
            <el-form-item>
              <el-button type="primary" @click="runBacktest" :loading="loading">
                开始回测
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
        
        <el-card v-if="result" class="result-card" title="回测结果">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="初始资金">
              {{ formatMoney(result.summary.initialCapital) }}
            </el-descriptions-item>
            <el-descriptions-item label="最终资金">
              {{ formatMoney(result.summary.finalCapital) }}
            </el-descriptions-item>
            <el-descriptions-item label="总收益率">
              <span :class="result.summary.totalReturn >= 0 ? 'up' : 'down'">
                {{ result.summary.totalReturn }}%
              </span>
            </el-descriptions-item>
            <el-descriptions-item label="年化收益率">
              <span :class="result.summary.annualizedReturn >= 0 ? 'up' : 'down'">
                {{ result.summary.annualizedReturn }}%
              </span>
            </el-descriptions-item>
            <el-descriptions-item label="最大回撤">
              {{ result.summary.maxDrawdown }}%
            </el-descriptions-item>
            <el-descriptions-item label="胜率">
              {{ result.summary.winRate }}%
            </el-descriptions-item>
            <el-descriptions-item label="交易次数">
              {{ result.summary.totalTrades }}
            </el-descriptions-item>
            <el-descriptions-item label="盈利次数">
              {{ result.summary.winningTrades }}
            </el-descriptions-item>
            <el-descriptions-item label="亏损次数">
              {{ result.summary.losingTrades }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
      
      <el-col :span="16">
        <el-card v-if="result" title="收益曲线">
          <v-chart class="chart" :option="chartOption" autoresize />
        </el-card>
        
        <el-card v-if="result" title="交易记录" class="trade-card">
          <el-table :data="result.trades" height="400">
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="type" label="类型" width="80">
              <template #default="{ row }">
                <el-tag :type="row.type === 'buy' ? 'danger' : 'success'">
                  {{ row.type === 'buy' ? '买入' : '卖出' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="price" label="价格" width="100">
              <template #default="{ row }">
                {{ row.price.toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column prop="shares" label="数量" width="100" />
            <el-table-column prop="amount" label="金额" width="120">
              <template #default="{ row }">
                {{ formatMoney(row.amount) }}
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" />
          </el-table>
        </el-card>
        
        <el-empty v-if="!result" description="设置参数并点击开始回测" />
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components'
import VChart from 'vue-echarts'
import { backtestApi, stockApi } from '@/api'
import type { BacktestResult } from '@/api'

use([
  CanvasRenderer,
  LineChart,
  GridComponent,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
])

const route = useRoute()
const loading = ref(false)
const result = ref<BacktestResult | null>(null)

const form = ref({
  tsCode: (route.query.tsCode as string) || '',
  startDate: '20220101',
  endDate: new Date().toISOString().split('T')[0].replace(/-/g, ''),
  initialCapital: 100000,
  strategy: 'ma_cross',
  params: {
    maShort: 5,
    maLong: 20,
  },
})

const chartOption = computed(() => {
  if (!result.value) return {}
  
  return {
    tooltip: {
      trigger: 'axis',
    },
    legend: {
      data: ['资金曲线'],
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: result.value.dailyValues.map(d => d.date),
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: (value: number) => (value / 10000).toFixed(1) + '万',
      },
    },
    series: [
      {
        name: '资金曲线',
        type: 'line',
        data: result.value.dailyValues.map(d => d.value),
        smooth: true,
        lineStyle: {
          color: '#409eff',
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(64, 158, 255, 0.3)' },
              { offset: 1, color: 'rgba(64, 158, 255, 0.05)' },
            ],
          },
        },
      },
    ],
  }
})

const searchStock = async () => {
  if (!form.value.tsCode) {
    ElMessage.warning('请输入股票代码')
    return
  }
  try {
    await stockApi.getStock(form.value.tsCode)
    ElMessage.success('股票存在')
  } catch {
    ElMessage.error('股票不存在')
  }
}

const runBacktest = async () => {
  if (!form.value.tsCode || !form.value.startDate || !form.value.endDate) {
    ElMessage.warning('请填写完整参数')
    return
  }
  
  loading.value = true
  try {
    const { data } = await backtestApi.run(form.value)
    result.value = data
    ElMessage.success('回测完成')
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '回测失败')
  } finally {
    loading.value = false
  }
}

const formatMoney = (value: number) => {
  return '¥' + value.toLocaleString('zh-CN', { minimumFractionDigits: 2 })
}
</script>

<style scoped>
.backtest {
  max-width: 1400px;
  margin: 0 auto;
}

.result-card {
  margin-top: 20px;
}

.trade-card {
  margin-top: 20px;
}

.chart {
  height: 400px;
}

.up {
  color: #f56c6c;
}

.down {
  color: #67c23a;
}
</style>
