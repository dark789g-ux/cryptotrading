<template>
  <div class="backtest-view">
    <div class="page-header">
      <h1 class="page-title">策略回测</h1>
      <n-button type="primary" @click="showCreateModal = true">
        <template #icon><n-icon><add-outline /></n-icon></template>
        新建策略
      </n-button>
    </div>

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

    <n-card class="strategy-table-card" :bordered="false">
      <n-data-table
        :columns="columns"
        :data="strategies"
        :loading="loading"
        :pagination="pagination"
        :row-key="(row: any) => row.id"
      />
    </n-card>

    <!-- 新建/编辑策略弹窗 -->
    <StrategyModal v-model:show="showCreateModal" :is-edit="false" @success="loadStrategies" />
    <StrategyModal v-model:show="showEditModal" :is-edit="true" :strategy="editingStrategy" @success="loadStrategies" />

    <!-- 回测详情抽屉 -->
    <n-drawer v-model:show="showDetailDrawer" :width="960" placement="right" :mask-closable="false" class="glass-drawer">
      <n-drawer-content :title="selectedStrategy?.name" closable>
        <BacktestDetail
          v-if="selectedStrategy"
          :strategy="selectedStrategy"
          :run="latestRun"
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
      :closable="(sse.status.value as string) !== 'running'"
      :mask-closable="(sse.status.value as string) !== 'running'"
    >
      <!-- 运行前选择标的 -->
      <div v-if="sse.status.value === 'idle'" class="symbol-selector">
        <p class="selector-hint">选择要回测的交易对（留空使用策略默认配置）</p>
        <n-select
          v-model:value="selectedSymbols"
          multiple
          filterable
          placeholder="搜索并选择标的..."
          :options="symbolOptions"
          :loading="loadingSymbols"
          max-tag-count="responsive"
        />
      </div>
      <div v-else class="run-progress">
        <n-progress
          type="line"
          :percentage="sse.percent.value"
          indicator-placement="inside"
          :status="sse.status.value === 'error' ? 'error' : sse.status.value === 'done' ? 'success' : 'default'"
        />
        <p class="phase-text">{{ sse.phase.value }} {{ sse.message.value ? `· ${sse.message.value}` : '' }}</p>
        <p v-if="sse.status.value === 'error'" class="error-text">{{ sse.message.value }}</p>
      </div>
      <template #action>
        <n-button v-if="sse.status.value === 'idle'" type="primary" @click="doRun">开始运行</n-button>
        <n-button @click="closeRunModal" :disabled="sse.status.value === 'running'">
          {{ sse.status.value === 'done' || sse.status.value === 'error' ? '关闭' : '取消' }}
        </n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { useMessage, useDialog, NButton, NIcon } from 'naive-ui'
import { AddOutline, PlayOutline, CreateOutline, TrashOutline, EyeOutline } from '@vicons/ionicons5'
import { strategyApi, backtestApi, symbolApi } from '../composables/useApi'
import { useSSE } from '../composables/useSSE'
import StrategyModal from '../components/backtest/StrategyModal.vue'
import BacktestDetail from '../components/backtest/BacktestDetail.vue'

const message = useMessage()
const dialog = useDialog()
const sse = useSSE()

const strategies = ref<any[]>([])
const loading = ref(false)
const showCreateModal = ref(false)
const showEditModal = ref(false)
const showDetailDrawer = ref(false)
const showRunModal = ref(false)
const editingStrategy = ref<any>(null)
const selectedStrategy = ref<any>(null)
const latestRun = ref<any>(null)
const detailLoading = ref(false)
const selectedSymbols = ref<string[]>([])
const symbolOptions = ref<{ label: string; value: string }[]>([])
const loadingSymbols = ref(false)

const pagination = ref({
  page: 1,
  pageSize: 10,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
  showQuickJumper: true,
  prefix: () => `共 ${strategies.value.length} 条`,
})

const backtestedCount = computed(() => strategies.value.filter((s) => s.lastBacktestAt).length)
const avgReturn = computed(() => {
  const tested = strategies.value.filter((s) => s.lastBacktestReturn != null)
  if (!tested.length) return 0
  return tested.reduce((a, s) => a + (s.lastBacktestReturn || 0), 0) / tested.length
})

const formatPercent = (val: number | null) => {
  if (val == null) return '-'
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`
}
const formatDate = (d: string | null) => (d ? new Date(d).toLocaleString('zh-CN') : '-')

const columns = [
  { title: '策略名称', key: 'name', width: 200, ellipsis: { tooltip: true } },
  {
    title: '类型', key: 'typeId', width: 120,
    render: (row: any) => ({ ma_kdj: 'MA+KDJ' }[row.typeId as string] || row.typeId),
  },
  {
    title: '时间周期', key: 'timeframe', width: 100,
    render: (row: any) => row.params?.timeframe || '-',
  },
  {
    title: '最近回测', key: 'lastBacktestAt', width: 160,
    sorter: (a: any, b: any) => new Date(a.lastBacktestAt || 0).getTime() - new Date(b.lastBacktestAt || 0).getTime(),
    render: (row: any) => formatDate(row.lastBacktestAt),
  },
  {
    title: '收益率', key: 'lastBacktestReturn', width: 120,
    sorter: (a: any, b: any) => (a.lastBacktestReturn || 0) - (b.lastBacktestReturn || 0),
    render: (row: any) => {
      const val = row.lastBacktestReturn
      if (val == null) return '-'
      return h('span', { class: val >= 0 ? 'trend-up' : 'trend-down' }, formatPercent(val))
    },
  },
  {
    title: '操作', key: 'actions', width: 240, fixed: 'right',
    render: (row: any) =>
      h('div', { class: 'action-btns' }, [
        h(NButton, { size: 'small', quaternary: true, onClick: () => handleViewDetail(row) },
          { icon: () => h(NIcon, null, () => h(EyeOutline)), default: () => '详情' }),
        h(NButton, { size: 'small', type: 'primary', onClick: () => openRunModal(row) },
          { icon: () => h(NIcon, null, () => h(PlayOutline)), default: () => '运行' }),
        h(NButton, { size: 'small', quaternary: true, onClick: () => handleEdit(row) },
          { icon: () => h(NIcon, null, () => h(CreateOutline)) }),
        h(NButton, { size: 'small', quaternary: true, type: 'error', onClick: () => handleDelete(row) },
          { icon: () => h(NIcon, null, () => h(TrashOutline)) }),
      ]),
  },
]

const loadStrategies = async () => {
  loading.value = true
  try { strategies.value = await strategyApi.getStrategies() }
  catch (err: any) { message.error(err.message) }
  finally { loading.value = false }
}

const handleViewDetail = async (row: any) => {
  selectedStrategy.value = row
  showDetailDrawer.value = true
  detailLoading.value = true
  try {
    const runs = await backtestApi.listRuns(row.id)
    latestRun.value = runs[0] ?? null
  } catch {
    latestRun.value = null
  } finally {
    detailLoading.value = false
  }
}

const openRunModal = async (row: any) => {
  selectedStrategy.value = row
  selectedSymbols.value = row.symbols ?? []
  sse.reset()
  showRunModal.value = true
  loadingSymbols.value = true
  try {
    const names = await symbolApi.getNames('1h')
    symbolOptions.value = names.map((s) => ({ label: s, value: s }))
  } finally {
    loadingSymbols.value = false
  }
}

const doRun = () => {
  sse.start(`/api/backtest/start/${selectedStrategy.value.id}`, {
    method: 'POST',
    body: { symbols: selectedSymbols.value },
    onDone: (data) => {
      message.success('回测完成')
      loadStrategies()
      if (data?.runId && showDetailDrawer.value) {
        backtestApi.getRun(data.runId).then((r) => (latestRun.value = r))
      }
    },
    onError: (msg) => message.error(msg),
  })
}

const closeRunModal = () => {
  sse.reset()
  showRunModal.value = false
}

const handleEdit = (row: any) => {
  editingStrategy.value = row
  showEditModal.value = true
}

const handleDelete = (row: any) => {
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
      } catch (err: any) { message.error(err.message) }
    },
  })
}

onMounted(loadStrategies)
</script>

<style scoped>
.backtest-view { max-width: 1400px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-title { font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: var(--ember-text); margin: 0; }
.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 24px; }
.strategy-table-card { background: var(--ember-surface); }
.action-btns { display: flex; gap: 4px; }
.run-progress { padding: 20px 0; }
.symbol-selector { padding: 8px 0 20px; }
.selector-hint { margin: 0 0 12px; color: var(--ember-text-secondary); font-size: 14px; }
.phase-text { text-align: center; margin-top: 12px; color: var(--ember-text-secondary); }
.error-text { text-align: center; margin-top: 8px; color: var(--color-error); }
</style>
