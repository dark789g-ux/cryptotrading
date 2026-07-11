<template>
  <div class="regime-backtest-view workspace-page workspace-page--medium">
    <div class="workspace-page-header">
      <div>
        <h1 class="workspace-page-title">Regime 回测</h1>
        <p class="page-subtitle">配置 Regime 规则并运行组合回测</p>
      </div>
    </div>

    <n-card :bordered="false" size="small">
      <!-- 工具栏：新建按钮 + 筛选区 -->
      <div class="regime-toolbar">
        <n-button type="primary" @click="showCreateModal = true">
          <template #icon><n-icon><add-outline /></n-icon></template>
          新建 Regime 回测
        </n-button>
        <div class="regime-filters">
          <n-select
            v-model:value="filterStatusDraft"
            :options="statusOptions"
            placeholder="状态"
            clearable
            style="width: 140px"
            @update:value="applyFilters"
          />
          <n-input
            v-model:value="filterKeywordDraft"
            placeholder="搜索方案名"
            clearable
            style="width: 200px"
            @keydown.enter="applyFilters"
            @clear="applyFilters"
          >
            <template #prefix>
              <n-icon><search-outline /></n-icon>
            </template>
          </n-input>
        </div>
      </div>

      <n-data-table
        :columns="listColumns"
        :data="listItems"
        :loading="listLoading"
        :pagination="listPagination"
        :bordered="false"
        size="small"
        :scroll-x="860"
      />
    </n-card>

    <!-- 新建弹窗 -->
    <RegimeBacktestCreateModal
      v-model:show="showCreateModal"
      @success="handleCreateSuccess"
    />

    <!-- 详情抽屉 -->
    <RegimeBacktestDetailDrawer
      v-model:show="showDetailDrawer"
      :run="detailRun"
      :daily="dailyRows"
      :daily-loading="dailyLoading"
      :trades="tradesRows"
      :trades-loading="tradesLoading"
      :initial-capital="detailInitialCapital"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NIcon,
  NInput,
  NSelect,
  NTag,
  NProgress,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { AddOutline, SearchOutline } from '@vicons/ionicons5'
import {
  regimeBacktestApi,
  type RegimeBacktestRun,
  type RegimeBacktestDaily,
  type RegimeBacktestTrade,
} from '@/api/modules/strategy/regimeEngine'
import RegimeBacktestCreateModal from '@/components/strategy/regime-backtest/RegimeBacktestCreateModal.vue'
import RegimeBacktestDetailDrawer from '@/components/strategy/regime-backtest/RegimeBacktestDetailDrawer.vue'

const message = useMessage()

// ── 筛选状态（双 buffer） ───────────────────────────────────────────────
const filterStatusDraft = ref<string | null>(null)
const filterKeywordDraft = ref('')
const filterStatusApplied = ref<string | null>(null)
const filterKeywordApplied = ref('')

const statusOptions = [
  { label: '等待中', value: 'pending' },
  { label: '运行中', value: 'running' },
  { label: '已完成', value: 'completed' },
  { label: '失败', value: 'failed' },
]

function applyFilters() {
  filterStatusApplied.value = filterStatusDraft.value
  filterKeywordApplied.value = filterKeywordDraft.value
  listPage.value = 1
  void loadList()
}

// ── 弹窗 / 抽屉显隐 ────────────────────────────────────────────────────
const showCreateModal = ref(false)
const showDetailDrawer = ref(false)

// ── 列表数据 ────────────────────────────────────────────────────────────
const listItems = ref<RegimeBacktestRun[]>([])
const listTotal = ref(0)
const listLoading = ref(false)
const listPage = ref(1)
const listPageSize = 20

const listPagination = computed(() => ({
  page: listPage.value,
  pageSize: listPageSize,
  itemCount: listTotal.value,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
  onChange: (p: number) => {
    listPage.value = p
    void loadList()
  },
}))

async function loadList() {
  listLoading.value = true
  try {
    const result = await regimeBacktestApi.list(listPage.value, listPageSize, {
      status: filterStatusApplied.value || undefined,
      keyword: filterKeywordApplied.value || undefined,
    })
    listItems.value = result.items
    listTotal.value = result.total
    result.items
      .filter((r) => r.status === 'running' || r.status === 'pending')
      .forEach((r) => startPolling(r.id))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '加载失败'
    message.error(msg)
  } finally {
    listLoading.value = false
  }
}

// ── 详情数据 ────────────────────────────────────────────────────────────
const detailRun = ref<RegimeBacktestRun | null>(null)
const detailInitialCapital = ref(1000000)
const dailyRows = ref<RegimeBacktestDaily[]>([])
const dailyLoading = ref(false)
const tradesRows = ref<RegimeBacktestTrade[]>([])
const tradesLoading = ref(false)

async function loadDetail(id: string) {
  dailyLoading.value = true
  tradesLoading.value = true
  try {
    const [run, daily, trades] = await Promise.all([
      regimeBacktestApi.get(id),
      regimeBacktestApi.listDaily(id),
      regimeBacktestApi.listTrades(id),
    ])
    detailRun.value = run
    const ic = run.config?.capital?.initialCapital
    if (typeof ic === 'number' && Number.isFinite(ic) && ic > 0) {
      detailInitialCapital.value = ic
    }
    dailyRows.value = daily
    tradesRows.value = trades
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '加载详情失败'
    message.error(msg)
  } finally {
    dailyLoading.value = false
    tradesLoading.value = false
  }
}

async function showDetail(run: RegimeBacktestRun) {
  showDetailDrawer.value = true
  detailRun.value = run
  dailyRows.value = []
  tradesRows.value = []
  await loadDetail(run.id)
}

// ── 轮询进度 ────────────────────────────────────────────────────────────
const progressTimers = ref<Map<string, ReturnType<typeof setInterval>>>(new Map())

function startPolling(id: string) {
  stopPolling(id)
  const timer = setInterval(async () => {
    try {
      const progress = await regimeBacktestApi.getProgress(id)
      const run = listItems.value.find((r) => r.id === id)
      if (run) {
        run.status = progress.status
        run.phase = progress.phase
        run.progressDone = progress.progressDone
        run.progressTotal = progress.progressTotal
        run.errorMessage = progress.errorMessage
      }
      if (progress.status === 'completed' || progress.status === 'failed') {
        stopPolling(id)
        if (progress.status === 'completed') {
          message.success('回测完成')
        } else {
          message.error(progress.errorMessage ?? '回测失败')
        }
        await loadList()
        if (detailRun.value?.id === id) {
          await loadDetail(id)
        }
      }
    } catch {
      stopPolling(id)
    }
  }, 2000)
  progressTimers.value.set(id, timer)
}

function stopPolling(id: string) {
  const t = progressTimers.value.get(id)
  if (t) {
    clearInterval(t)
    progressTimers.value.delete(id)
  }
}

// ── 操作：删除 ──────────────────────────────────────────────────────────
async function handleRemove(id: string) {
  stopPolling(id)
  try {
    await regimeBacktestApi.remove(id)
    message.success('已删除')
    if (detailRun.value?.id === id) {
      detailRun.value = null
      dailyRows.value = []
      tradesRows.value = []
      showDetailDrawer.value = false
    }
    await loadList()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '删除失败'
    message.error(msg)
  }
}

// ── 操作：创建成功回调 ─────────────────────────────────────────────────
function handleCreateSuccess(run: RegimeBacktestRun) {
  startPolling(run.id)
  listPage.value = 1
  void loadList()
}

// ── 列定义 ────────────────────────────────────────────────────────────
function statusLabel(run: RegimeBacktestRun): string {
  switch (run.status) {
    case 'pending': return '等待中'
    case 'running': return run.phase ?? '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    default: return run.status
  }
}

function statusType(run: RegimeBacktestRun): 'default' | 'info' | 'success' | 'error' {
  switch (run.status) {
    case 'pending': return 'default'
    case 'running': return 'info'
    case 'completed': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
}

function fmtPct(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return `${(val * 100).toFixed(2)}%`
}

const listColumns: DataTableColumns<RegimeBacktestRun> = [
  {
    title: '方案名',
    key: 'name',
    width: 160,
    fixed: 'left',
    ellipsis: { tooltip: true },
  },
  {
    title: '版本',
    key: 'regimeConfigVersion',
    width: 60,
    render: (row) =>
      row.regimeConfigVersion == null ? '内联' : `v${row.regimeConfigVersion}`,
  },
  {
    title: '区间',
    key: 'range',
    width: 180,
    render: (row) => `${row.dateStart.slice(0, 4)}-${row.dateStart.slice(4, 6)}-${row.dateStart.slice(6, 8)} ~ ${row.dateEnd.slice(0, 4)}-${row.dateEnd.slice(4, 6)}-${row.dateEnd.slice(6, 8)}`,
  },
  {
    title: '状态',
    key: 'status',
    width: 140,
    render: (row) => {
      const tag = h(
        NTag,
        { type: statusType(row), bordered: false, size: 'small' },
        { default: () => statusLabel(row) },
      )
      if (row.status === 'running' && row.progressTotal && row.progressTotal > 0) {
        const pct = Math.round(((row.progressDone ?? 0) / row.progressTotal) * 100)
        return h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          tag,
          h(NProgress, {
            type: 'line',
            percentage: pct,
            indicatorPlacement: 'inside',
            style: 'width:80px',
            showIndicator: false,
          }),
        ])
      }
      return tag
    },
  },
  {
    title: '总收益',
    key: 'totalRet',
    width: 80,
    render: (row) => fmtPct(row.totalRet),
  },
  {
    title: 'Sharpe',
    key: 'sharpe',
    width: 70,
    render: (row) => (row.sharpe != null ? row.sharpe.toFixed(2) : '-'),
  },
  {
    title: '回撤',
    key: 'maxDrawdown',
    width: 80,
    render: (row) => fmtPct(row.maxDrawdown),
  },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    fixed: 'right',
    render: (row) => {
      return h('div', { style: 'display:flex;gap:4px' }, [
        h(
          NButton,
          { size: 'tiny', quaternary: true, onClick: () => void showDetail(row) },
          { default: () => '查看' },
        ),
        h(
          NButton,
          { size: 'tiny', quaternary: true, type: 'error', onClick: () => void handleRemove(row.id) },
          { default: () => '删除' },
        ),
      ])
    },
  },
]

// ── 生命周期 ────────────────────────────────────────────────────────────
onMounted(async () => {
  await loadList()
})

onUnmounted(() => {
  progressTimers.value.forEach((t) => clearInterval(t))
  progressTimers.value.clear()
})
</script>

<style scoped>
.regime-backtest-view { padding: 16px; }
.page-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }
.regime-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; }
.regime-filters { display: flex; gap: 8px; align-items: center; }
</style>
