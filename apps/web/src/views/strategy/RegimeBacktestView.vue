<template>
  <div class="regime-backtest-view workspace-page workspace-page--medium">
    <div class="workspace-page-header">
      <div>
        <h1 class="workspace-page-title">Regime 回测</h1>
        <p class="page-subtitle">基于 Regime 配置的组合级回测</p>
      </div>
    </div>

    <RegimeBacktestCreateForm
      ref="createFormRef"
      :configs="configs"
      :submitting="creating"
      @submit="handleCreateAndRun"
    />

    <n-card title="历史回测" :bordered="false" size="small" style="margin-top: 16px">
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

    <template v-if="detailRun">
      <n-card title="汇总指标" :bordered="false" size="small" style="margin-top: 16px">
        <RegimeBacktestSummaryCards :run="detailRun" />
      </n-card>

      <n-card title="净值曲线" :bordered="false" size="small" style="margin-top: 16px">
        <n-spin :show="dailyLoading">
          <RegimeBacktestNavChart
            v-if="dailyRows.length > 0"
            :rows="dailyRows"
            :initial-capital="detailInitialCapital"
          />
          <n-empty v-else description="暂无净值数据" />
        </n-spin>
      </n-card>

      <n-card title="交易明细" :bordered="false" size="small" style="margin-top: 16px">
        <n-spin :show="tradesLoading">
          <RegimeBacktestTradesTable v-if="tradesRows.length > 0" :trades="tradesRows" />
          <n-empty v-else description="暂无交易数据" />
        </n-spin>
      </n-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NSpin,
  NTag,
  NProgress,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import {
  regimeEngineApi,
  regimeBacktestApi,
  type RegimeStrategyConfig,
  type RegimeBacktestRun,
  type RegimeBacktestDaily,
  type RegimeBacktestTrade,
} from '@/api/modules/strategy/regimeEngine'
import RegimeBacktestCreateForm from '@/components/strategy/regime-backtest/RegimeBacktestCreateForm.vue'
import RegimeBacktestSummaryCards from '@/components/strategy/regime-backtest/RegimeBacktestSummaryCards.vue'
import RegimeBacktestNavChart from '@/components/strategy/regime-backtest/RegimeBacktestNavChart.vue'
import RegimeBacktestTradesTable from '@/components/strategy/regime-backtest/RegimeBacktestTradesTable.vue'

const message = useMessage()

const createFormRef = ref<InstanceType<typeof RegimeBacktestCreateForm> | null>(null)

const configs = ref<RegimeStrategyConfig[]>([])
const creating = ref(false)

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

const detailRun = ref<RegimeBacktestRun | null>(null)
const detailInitialCapital = ref(1000000)
const dailyRows = ref<RegimeBacktestDaily[]>([])
const dailyLoading = ref(false)
const tradesRows = ref<RegimeBacktestTrade[]>([])
const tradesLoading = ref(false)

const progressTimers = ref<Map<string, ReturnType<typeof setInterval>>>(new Map())

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
    key: 'configVersion',
    width: 60,
    render: (row) => `v${row.configVersion}`,
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

async function loadConfigs() {
  try {
    configs.value = await regimeEngineApi.listConfigs()
  } catch {
    // 非致命
  }
}

async function loadList() {
  listLoading.value = true
  try {
    const result = await regimeBacktestApi.list(listPage.value, listPageSize)
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

async function handleCreateAndRun() {
  const fd = createFormRef.value?.getFormData()
  if (!fd || !fd.regimeConfigId || !fd.dateStart || !fd.dateEnd) {
    message.warning('请填写完整参数')
    return
  }
  creating.value = true
  try {
    const run = await regimeBacktestApi.create(fd)
    message.success(`回测已创建：${run.name}`)
    startPolling(run.id)
    await nextTick()
    listPage.value = 1
    await loadList()
    await regimeBacktestApi.run(run.id)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '创建失败'
    message.error(msg)
  } finally {
    creating.value = false
  }
}

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

async function showDetail(run: RegimeBacktestRun) {
  detailRun.value = run
  dailyRows.value = []
  tradesRows.value = []
  await loadDetail(run.id)
}

async function loadDetail(id: string) {
  try {
    const [run, daily, trades] = await Promise.all([
      regimeBacktestApi.get(id),
      regimeBacktestApi.listDaily(id),
      regimeBacktestApi.listTrades(id),
    ])
    detailRun.value = run
    dailyRows.value = daily
    tradesRows.value = trades
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '加载详情失败'
    message.error(msg)
  }
}

async function handleRemove(id: string) {
  stopPolling(id)
  try {
    await regimeBacktestApi.remove(id)
    message.success('已删除')
    if (detailRun.value?.id === id) {
      detailRun.value = null
      dailyRows.value = []
      tradesRows.value = []
    }
    await loadList()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '删除失败'
    message.error(msg)
  }
}

watch(listPage, () => {
  void loadList()
})

onMounted(async () => {
  await Promise.all([loadConfigs(), loadList()])
})

onUnmounted(() => {
  progressTimers.value.forEach((t) => clearInterval(t))
  progressTimers.value.clear()
})
</script>

<style scoped>
.regime-backtest-view {
  padding: 16px;
}

.page-subtitle {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}
</style>
