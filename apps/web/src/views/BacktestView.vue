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
        :data="tableRows"
        :loading="loading"
        :pagination="pagination"
        :row-key="(row: any) => row.id"
        remote
        @update:sorter="handleSorterChange"
      />
    </n-card>

    <!-- 新建/编辑策略弹窗 -->
    <StrategyModal v-model:show="showCreateModal" :is-edit="false" @success="loadStrategies" />
    <StrategyModal v-model:show="showEditModal" :is-edit="true" :strategy="editingStrategy" @success="loadStrategies" />

    <!-- 回测进度 Modal -->
    <n-modal
      v-model:show="showProgressModal"
      :mask-closable="!isProgressRunning"
      :closable="!isProgressRunning"
      preset="card"
      :title="`回测进度 · ${progressModalStrategyName}`"
      style="width: 480px"
    >
      <div class="progress-modal-body">
        <template v-if="progressModalData">
          <div class="progress-status-row">
            <n-tag v-if="progressModalData.status === 'running'" type="info" size="small" :bordered="false">运行中</n-tag>
            <n-tag v-else-if="progressModalData.status === 'done'" type="success" size="small" :bordered="false">已完成</n-tag>
            <n-tag v-else-if="progressModalData.status === 'error'" type="error" size="small" :bordered="false">失败</n-tag>
          </div>
          <n-progress
            type="line"
            :percentage="Math.round(Math.max(0, Math.min(100, progressModalData.percent)))"
            :status="progressModalData.status === 'done' ? 'success' : progressModalData.status === 'error' ? 'error' : 'default'"
            indicator-placement="inside"
            style="margin: 14px 0 18px"
          />
          <div class="progress-details">
            <div class="progress-detail-item">
              <span class="detail-label">当前阶段</span>
              <span class="detail-value">{{ progressModalData.phase || '-' }}</span>
            </div>
            <div class="progress-detail-item">
              <span class="detail-label">处理时间戳</span>
              <span class="detail-value">{{ formatTs(progressModalData.currentTs) }}</span>
            </div>
            <div class="progress-detail-item">
              <span class="detail-label">已用时间</span>
              <span class="detail-value">{{ formatMs(progressModalData.elapsedMs) }}</span>
            </div>
            <div v-if="progressModalData.etaMs != null" class="progress-detail-item">
              <span class="detail-label">预计剩余</span>
              <span class="detail-value">{{ formatMs(progressModalData.etaMs) }}</span>
            </div>
            <div v-if="progressModalData.status === 'error'" class="progress-error-msg">
              {{ progressModalData.message || '回测失败' }}
            </div>
          </div>
        </template>
        <div v-else class="progress-init">正在初始化…</div>
      </div>
    </n-modal>

    <!-- 回测详情抽屉 -->
    <n-drawer
      v-model:show="showDetailDrawer"
      width="min(1200px, 92vw)"
      placement="right"
      :mask-closable="false"
      class="glass-drawer"
    >
      <n-drawer-content :title="selectedStrategy ? `回测详情-${selectedStrategy.name}` : ''" closable>
        <BacktestDetail
          v-if="selectedStrategy"
          :strategy="selectedStrategy"
          :run="latestRun"
          :loading="detailLoading"
        />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, h } from 'vue'
import {
  useMessage, useDialog,
  NButton, NIcon, NCard, NDataTable, NDrawer, NDrawerContent,
  NProgress, NTooltip, NModal, NTag, type DataTableSortState,
} from 'naive-ui'
import { AddOutline, PlayOutline, CreateOutline, TrashOutline, EyeOutline } from '@vicons/ionicons5'
import { strategyApi, backtestApi, type BacktestProgress } from '../composables/useApi'
import StrategyModal from '../components/backtest/StrategyModal.vue'
import BacktestDetail from '../components/backtest/BacktestDetail.vue'

const message = useMessage()
const dialog = useDialog()

const strategies = ref<any[]>([])
const loading = ref(false)
const showCreateModal = ref(false)
const showEditModal = ref(false)
const showDetailDrawer = ref(false)
const editingStrategy = ref<any>(null)
const selectedStrategy = ref<any>(null)
const latestRun = ref<any>(null)
const detailLoading = ref(false)
const sortField = ref('createdAt')
const sortOrder = ref<'ASC' | 'DESC'>('DESC')

// ── 进度 Modal ────────────────────────────────────────────────
const showProgressModal = ref(false)
const progressModalStrategyId = ref<string | null>(null)
const progressModalStrategyName = ref('')
const progressModalData = ref<BacktestProgress | null>(null)

const isProgressRunning = computed(() =>
  !!progressModalStrategyId.value && pollingIds.value.has(progressModalStrategyId.value),
)

// ── 进度轮询 ──────────────────────────────────────────────────
const progressMap = ref<Record<string, BacktestProgress>>({})
const pollErrorCount: Record<string, number> = {}
const pollingIds = ref(new Set<string>())
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollTick() {
  for (const id of pollingIds.value) {
    try {
      const p = await backtestApi.getProgress(id)
      pollErrorCount[id] = 0
      if (!p) {
        pollingIds.value.delete(id)
        const updated = { ...progressMap.value }
        delete updated[id]
        progressMap.value = updated
        checkStopTimer()
        continue
      }
      progressMap.value = { ...progressMap.value, [id]: p }
      if (progressModalStrategyId.value === id) progressModalData.value = p
      if (p.status === 'done' || p.status === 'error') {
        pollingIds.value.delete(id)
        checkStopTimer()
        if (p.status === 'done') {
          message.success('回测完成')
          if (p.runId && showDetailDrawer.value && selectedStrategy.value?.id === id) {
            backtestApi.getRun(p.runId).then((r) => (latestRun.value = r))
          }
        } else {
          message.error(p.message || '回测失败')
        }
        loadStrategies()
      }
    } catch {
      pollErrorCount[id] = (pollErrorCount[id] ?? 0) + 1
      if (pollErrorCount[id] >= 3) {
        const errProgress = { ...progressMap.value[id], status: 'error' as const, message: '进度查询失败' }
        progressMap.value = { ...progressMap.value, [id]: errProgress }
        if (progressModalStrategyId.value === id) progressModalData.value = errProgress
        pollingIds.value.delete(id)
        checkStopTimer()
      }
    }
  }
}

function checkStopTimer() {
  if (!pollingIds.value.size && pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPolling(strategyId: string) {
  pollingIds.value.add(strategyId)
  pollErrorCount[strategyId] = 0
  if (!pollTimer) {
    pollTick()
    pollTimer = setInterval(pollTick, 500)
  }
}

onBeforeUnmount(() => {
  if (pollTimer !== null) clearInterval(pollTimer)
})

// ── 格式化工具 ────────────────────────────────────────────────
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

function formatMs(ms: number | null): string {
  if (ms == null || ms < 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function formatTs(ts: string | null): string {
  if (!ts) return '-'
  return ts.slice(0, 16).replace('T', ' ')
}

// ── 表格列定义 ────────────────────────────────────────────────
const tableRows = computed(() => strategies.value)
const BASE_COLS: Record<string, object> = {
  name: { key: 'name', width: 200, ellipsis: { tooltip: true } },
  typeId: { key: 'typeId', width: 120, render: (row: any) => ({ ma_kdj: 'MA+KDJ' }[row.typeId as string] || row.typeId) },
  timeframe: { key: 'timeframe', width: 100, render: (row: any) => row.timeframe || '-' },
  createdAt: { key: 'createdAt', width: 160, sorter: true, render: (row: any) => formatDate(row.createdAt) },
  lastBacktestAt: { key: 'lastBacktestAt', width: 160, sorter: true, render: (row: any) => formatDate(row.lastBacktestAt) },
  lastBacktestReturn: {
    key: 'lastBacktestReturn', width: 120, sorter: true,
    render: (row: any) => {
      const val = row.lastBacktestReturn
      if (val == null) return '-'
      return h('span', { class: val >= 0 ? 'trend-up' : 'trend-down' }, formatPercent(val))
    },
  },
}

const COL_LABELS: Record<string, string> = {
  name: '策略名称', typeId: '类型', timeframe: '时间周期',
  createdAt: '创建时间', lastBacktestAt: '最近回测', lastBacktestReturn: '收益率',
}

const COL_KEYS = ['name', 'typeId', 'timeframe', 'createdAt', 'lastBacktestAt', 'lastBacktestReturn']

const columns = computed(() => {
  const ordered = COL_KEYS.map((key) => ({
    ...BASE_COLS[key],
    title: COL_LABELS[key],
    sortOrder: (BASE_COLS[key] as any).sorter
      ? (sortField.value === key ? (sortOrder.value === 'ASC' ? 'ascend' : 'descend') : false)
      : undefined,
  }))
  return [
    ...ordered,
    {
      title: '操作', key: 'actions', width: 180, fixed: 'right',
      render: (row: any) => {
        const withTip = (tip: string, icon: any, onClick: () => void, type?: 'primary' | 'error') =>
          h(NTooltip, null, {
            trigger: () => h(NButton, { size: 'small', type, onClick }, {
              icon: () => h(NIcon, null, { default: () => h(icon) }),
            }),
            default: () => tip,
          })
        return h('div', { class: 'action-btns' }, [
          withTip('详情', EyeOutline, () => handleViewDetail(row)),
          withTip('运行', PlayOutline, () => openRun(row), 'primary'),
          withTip('编辑', CreateOutline, () => handleEdit(row)),
          withTip('删除', TrashOutline, () => handleDelete(row), 'error'),
        ])
      },
    },
  ]
})

// ── 事件处理 ──────────────────────────────────────────────────
const handleSorterChange = (sorter: DataTableSortState | null) => {
  const clickedKey = (sorter?.columnKey as string | undefined) ?? null
  if (!clickedKey) return
  if (clickedKey === sortField.value) {
    sortOrder.value = sortOrder.value === 'DESC' ? 'ASC' : 'DESC'
  } else {
    sortField.value = clickedKey
    sortOrder.value = 'DESC'
  }
  loadStrategies()
}

const loadStrategies = async () => {
  loading.value = true
  try { strategies.value = await strategyApi.getStrategies(sortField.value, sortOrder.value) }
  catch (err: any) { message.error(err.message) }
  finally { loading.value = false }
}

const handleViewDetail = async (row: any) => {
  showDetailDrawer.value = true
  detailLoading.value = true
  selectedStrategy.value = null
  try {
    const [full, runs] = await Promise.all([
      strategyApi.getStrategy(row.id),
      backtestApi.listRuns(row.id),
    ])
    selectedStrategy.value = full
    latestRun.value = runs[0] ?? null
  } catch (err: any) {
    latestRun.value = null
    message.error(err.message)
  } finally {
    detailLoading.value = false
  }
}

const openRun = async (row: any) => {
  // 若当前策略已在运行，直接打开进度 Modal，不重复启动
  if (pollingIds.value.has(row.id)) {
    progressModalStrategyId.value = row.id
    progressModalStrategyName.value = row.name
    progressModalData.value = progressMap.value[row.id] ?? null
    showProgressModal.value = true
    return
  }

  let full: any
  try { full = await strategyApi.getStrategy(row.id) }
  catch (err: any) { message.error(err.message); return }
  if (!full.symbols?.length) {
    message.warning('该策略尚未配置标的，请先编辑策略选择标的')
    return
  }
  const result = await backtestApi.start(full.id, full.symbols)
  if (!result.ok) {
    message.warning(result.message || '启动失败')
    return
  }
  const initProgress: BacktestProgress = {
    status: 'running', phase: '初始化', percent: 0,
    currentTs: null, startTs: null, endTs: null,
    elapsedMs: 0, etaMs: null,
  }
  progressMap.value = { ...progressMap.value, [full.id]: initProgress }
  progressModalData.value = initProgress
  startPolling(full.id)
  progressModalStrategyId.value = full.id
  progressModalStrategyName.value = full.name
  showProgressModal.value = true
}

const handleEdit = async (row: any) => {
  try {
    editingStrategy.value = await strategyApi.getStrategy(row.id)
    showEditModal.value = true
  } catch (err: any) { message.error(err.message) }
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
.backtest-view { max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-title { font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: var(--ember-text); margin: 0; }
.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 24px; }
.strategy-table-card { background: var(--ember-surface); }
.action-btns { display: flex; gap: 8px; }
.progress-modal-body { padding: 4px 0; }
.progress-status-row { margin-bottom: 4px; }
.progress-details { display: flex; flex-direction: column; gap: 10px; }
.progress-detail-item { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.detail-label { color: var(--n-text-color-3, #999); }
.detail-value { font-variant-numeric: tabular-nums; }
.progress-error-msg { margin-top: 6px; padding: 8px 12px; background: rgba(231,76,60,.08); border-radius: 6px; color: #e74c3c; font-size: 13px; }
.progress-init { color: var(--n-text-color-3, #999); font-size: 13px; text-align: center; padding: 24px 0; }
</style>
