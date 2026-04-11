<template>
  <div class="backtest-view">
    <!-- 页面标题 -->
    <div class="page-header">
      <h1 class="page-title">策略回测</h1>
      <n-button type="primary" @click="showCreateModal = true">
        <template #icon>
          <n-icon><add-outline /></n-icon>
        </template>
        新建策略
      </n-button>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">策略总数</div>
        <div class="stat-value">{{ strategies.length }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已回测</div>
        <div class="stat-value">{{ backtestedCount }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">平均收益率</div>
        <div class="stat-value" :class="avgReturn >= 0 ? 'trend-up' : 'trend-down'">
          {{ formatPercent(avgReturn) }}
        </div>
      </div>
    </div>

    <!-- 策略列表 -->
    <n-card class="strategy-table-card" :bordered="false">
      <n-data-table
        :columns="columns"
        :data="strategies"
        :loading="loading"
        :pagination="pagination"
        :row-key="row => row.id"
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
      />
    </n-card>

    <!-- 新建/编辑策略弹窗 -->
    <StrategyModal
      v-model:show="showCreateModal"
      :is-edit="false"
      @success="loadStrategies"
    />

    <StrategyModal
      v-model:show="showEditModal"
      :is-edit="true"
      :strategy="editingStrategy"
      @success="loadStrategies"
    />

    <!-- 回测详情抽屉 -->
    <n-drawer
      v-model:show="showDetailDrawer"
      :width="900"
      placement="right"
      :mask-closable="false"
      class="glass-drawer"
    >
      <n-drawer-content :title="selectedStrategy?.name" closable>
        <BacktestDetail
          v-if="selectedStrategy"
          :strategy="selectedStrategy"
          :result="backtestResult"
          :loading="detailLoading"
        />
      </n-drawer-content>
    </n-drawer>

    <!-- 运行回测弹窗 -->
    <n-modal
      v-model:show="showRunModal"
      title="运行回测"
      preset="dialog"
      :show-icon="false"
      :closable="!isRunning"
      :mask-closable="!isRunning"
    >
      <div class="run-progress">
        <n-progress
          type="line"
          :percentage="runProgress"
          :indicator-placement="'inside'"
          :status="runStatus === 'error' ? 'error' : runStatus === 'done' ? 'success' : 'default'"
        />
        <p class="phase-text">{{ runPhase }}</p>
        <p v-if="runStatus === 'error'" class="error-text">{{ runError }}</p>
      </div>
      <template #action>
        <n-button @click="showRunModal = false" :disabled="isRunning">关闭</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue'
import { useMessage, useDialog, NButton, NIcon, NCard, NDataTable, NDrawer, NDrawerContent, NModal, NProgress } from 'naive-ui'
import { AddOutline, PlayOutline, CreateOutline, TrashOutline, EyeOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { strategyApi } from '../composables/useApi.js'
import StrategyModal from '../components/backtest/StrategyModal.vue'
import BacktestDetail from '../components/backtest/BacktestDetail.vue'

const message = useMessage()
const dialog = useDialog()

// 数据状态
const strategies = ref([])
const loading = ref(false)
const showCreateModal = ref(false)
const showEditModal = ref(false)
const showDetailDrawer = ref(false)
const showRunModal = ref(false)
const editingStrategy = ref(null)
const selectedStrategy = ref(null)
const backtestResult = ref(null)
const detailLoading = ref(false)

// 运行回测状态
const isRunning = ref(false)
const runProgress = ref(0)
const runPhase = ref('')
const runStatus = ref('')
const runError = ref('')

// 分页配置
const pagination = ref({
  page: 1,
  pageSize: 10,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
  showQuickJumper: true,
  prefix: () => `共 ${strategies.value.length} 条`
})

// 统计数据
const backtestedCount = computed(() => 
  strategies.value.filter(s => s.last_backtest_at).length
)

const avgReturn = computed(() => {
  const tested = strategies.value.filter(s => s.last_backtest_return !== null && s.last_backtest_return !== undefined)
  if (tested.length === 0) return 0
  const sum = tested.reduce((acc, s) => acc + (s.last_backtest_return || 0), 0)
  return sum / tested.length
})

// 格式化百分比
const formatPercent = (val) => {
  if (val === null || val === undefined) return '-'
  const sign = val >= 0 ? '+' : ''
  return `${sign}${(val * 100).toFixed(2)}%`
}

// 格式化日期
const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

// 表格列配置
const columns = [
  {
    title: '策略名称',
    key: 'name',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: '类型',
    key: 'type',
    width: 120,
    render(row) {
      const typeMap = {
        'ma_kdj': 'MA+KDJ'
      }
      return typeMap[row.type] || row.type
    }
  },
  {
    title: '时间周期',
    key: 'params.timeframe',
    width: 100,
    render(row) {
      return row.params?.timeframe || '-'
    }
  },
  {
    title: '最近回测',
    key: 'last_backtest_at',
    width: 160,
    sorter: (a, b) => new Date(a.last_backtest_at || 0) - new Date(b.last_backtest_at || 0),
    render(row) {
      return formatDate(row.last_backtest_at)
    }
  },
  {
    title: '收益率',
    key: 'last_backtest_return',
    width: 120,
    sorter: (a, b) => (a.last_backtest_return || 0) - (b.last_backtest_return || 0),
    render(row) {
      const val = row.last_backtest_return
      if (val === null || val === undefined) return '-'
      return h('span', {
        class: val >= 0 ? 'trend-up' : 'trend-down'
      }, formatPercent(val))
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 240,
    fixed: 'right',
    render(row) {
      return h('div', { class: 'action-btns' }, [
        h(NButton, {
          size: 'small',
          quaternary: true,
          onClick: () => handleViewDetail(row)
        }, {
          icon: () => h(NIcon, null, () => h(EyeOutline)),
          default: () => '详情'
        }),
        h(NButton, {
          size: 'small',
          type: 'primary',
          onClick: () => handleRunBacktest(row),
          loading: isRunning.value && selectedStrategy.value?.id === row.id
        }, {
          icon: () => h(NIcon, null, () => h(PlayOutline)),
          default: () => '运行'
        }),
        h(NButton, {
          size: 'small',
          quaternary: true,
          onClick: () => handleEdit(row)
        }, {
          icon: () => h(NIcon, null, () => h(CreateOutline))
        }),
        h(NButton, {
          size: 'small',
          quaternary: true,
          type: 'error',
          onClick: () => handleDelete(row)
        }, {
          icon: () => h(NIcon, null, () => h(TrashOutline))
        })
      ])
    }
  }
]

// 加载策略列表
const loadStrategies = async () => {
  loading.value = true
  try {
    strategies.value = await strategyApi.getStrategies()
  } catch (err) {
    message.error(err.message)
  } finally {
    loading.value = false
  }
}

// 查看详情
const handleViewDetail = async (row) => {
  selectedStrategy.value = row
  showDetailDrawer.value = true
  detailLoading.value = true
  try {
    backtestResult.value = await strategyApi.getBacktestResult(row.id)
  } catch (err) {
    message.warning('暂无回测结果')
    backtestResult.value = null
  } finally {
    detailLoading.value = false
  }
}

// 运行回测
const handleRunBacktest = (row) => {
  selectedStrategy.value = row
  showRunModal.value = true
  isRunning.value = true
  runProgress.value = 0
  runPhase.value = '准备中...'
  runStatus.value = 'running'
  runError.value = ''

  const es = strategyApi.runBacktest(row.id)

  es.onmessage = (event) => {
    const data = JSON.parse(event.data)
    
    switch (data.type) {
      case 'start':
        runPhase.value = '开始回测...'
        break
      case 'progress':
        runProgress.value = data.percent
        runPhase.value = `${data.phase} (${data.current}/${data.total})`
        break
      case 'done':
        runStatus.value = 'done'
        runProgress.value = 100
        runPhase.value = '回测完成!'
        isRunning.value = false
        message.success('回测完成')
        loadStrategies()
        es.close()
        break
      case 'error':
        runStatus.value = 'error'
        runError.value = data.message
        isRunning.value = false
        message.error(data.message)
        es.close()
        break
    }
  }

  es.onerror = () => {
    runStatus.value = 'error'
    runError.value = '连接失败'
    isRunning.value = false
    es.close()
  }
}

// 编辑策略
const handleEdit = (row) => {
  editingStrategy.value = row
  showEditModal.value = true
}

// 删除策略
const handleDelete = (row) => {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除策略 "${row.name}" 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await strategyApi.deleteStrategy(row.id)
        message.success('删除成功')
        loadStrategies()
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

// 分页处理
const handlePageChange = (page) => {
  pagination.value.page = page
}

const handlePageSizeChange = (size) => {
  pagination.value.pageSize = size
  pagination.value.page = 1
}

onMounted(() => {
  loadStrategies()
})
</script>

<style scoped>
.backtest-view {
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

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-bottom: 24px;
}

.strategy-table-card {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
}

.action-btns {
  display: flex;
  gap: 4px;
}

.run-progress {
  padding: 20px 0;
}

.phase-text {
  text-align: center;
  margin-top: 12px;
  color: var(--text-secondary);
}

.error-text {
  text-align: center;
  margin-top: 8px;
  color: var(--color-error);
}

:deep(.n-data-table .n-data-table-th) {
  font-weight: 600;
}
</style>
