<template>
  <div class="signal-stats-result">
    <!-- Latest run progress / status -->
    <template v-if="latestProgress">
      <div v-if="latestProgress.status === 'running'" class="progress-section">
        <n-progress
          type="line"
          :percentage="progressPct"
          :indicator-placement="'inside'"
          :color="'#2080f0'"
          :height="20"
        />
        <span class="progress-label">
          扫描中 {{ latestProgress.progressScanned }} / {{ latestProgress.progressTotal }}
        </span>
      </div>

      <n-alert
        v-if="latestProgress.status === 'failed'"
        type="error"
        title="运行失败"
        :bordered="false"
        style="margin-bottom: 16px"
      >
        {{ latestProgress.errorMessage ?? '未知错误' }}
      </n-alert>

      <!-- Metrics cards: only show when completed -->
      <template v-if="latestProgress.status === 'completed'">
        <n-grid :cols="4" :x-gap="12" :y-gap="12" class="metrics-grid">
          <n-grid-item>
            <n-statistic label="样本数">
              <span>{{ latestProgress.sampleCount ?? '—' }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="胜率">
              <n-tooltip v-if="latestProgress.winRate !== null" trigger="hover">
                <template #trigger>
                  <span>{{ fmtPct(latestProgress.winRate) }}</span>
                </template>
                盈利笔数 / 总样本数
              </n-tooltip>
              <span v-else>—</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="赔率 b">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestProgress.payoffRatio) }}</span>
                </template>
                <span v-if="latestProgress.payoffRatio !== null">均盈 / |均亏|</span>
                <span v-else>无亏损样本，赔率无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="盈亏比 PF">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestProgress.profitFactor) }}</span>
                </template>
                <span v-if="latestProgress.profitFactor !== null">总盈利 / |总亏损|</span>
                <span v-else>无亏损样本，PF 无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="凯利 f*">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestProgress.kellyF) }}</span>
                </template>
                <span v-if="latestProgress.kellyF !== null">Kelly 最优仓位比例</span>
                <span v-else>无亏损样本，凯利无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均持仓天数">
              <span>{{ fmtNullable(latestProgress.avgHoldDays) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均盈">
              <span>{{ fmtPctNullable(latestProgress.avgWin) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="最差单笔">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span :style="worstStyle(latestProgress.worstTradeRet)">
                    {{ fmtPctNullable(latestProgress.worstTradeRet) }}
                  </span>
                </template>
                历史最大单笔亏损
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
        </n-grid>
      </template>
    </template>

    <!-- Historical runs table -->
    <n-divider v-if="runs.length > 0">历史运行对比</n-divider>
    <n-data-table
      v-if="runs.length > 0"
      :columns="runColumns"
      :data="runs"
      :bordered="false"
      size="small"
      :row-class-name="(row: SignalTestRun) => row.id === selectedRunId ? 'run-row--selected' : ''"
    />

    <!-- Trade detail table -->
    <template v-if="selectedRunId">
      <n-divider>逐笔明细</n-divider>
      <n-data-table
        :columns="tradeColumns"
        :data="trades"
        :loading="tradesLoading"
        :bordered="false"
        size="small"
        :pagination="tradePagination"
        remote
        @update:page="handlePageChange"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue'
import {
  NGrid,
  NGridItem,
  NStatistic,
  NTooltip,
  NProgress,
  NAlert,
  NDivider,
  NDataTable,
  NButton,
  NTag,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useSignalStatsStore } from '../../stores/signalStats'
import type { SignalTestRun, SignalTestTrade, SignalTestRunProgress } from '../../api/modules/strategy/signalStats'

interface Props {
  testId: string | null
}

const props = defineProps<Props>()

const store = useSignalStatsStore()

const runs = computed<SignalTestRun[]>(() =>
  props.testId ? (store.runsMap.get(props.testId) ?? []) : [],
)

const latestProgress = computed<SignalTestRunProgress | null>(() =>
  props.testId ? (store.runProgress.get(props.testId) ?? null) : null,
)

const progressPct = computed(() => {
  const p = latestProgress.value
  if (!p || p.progressTotal === 0) return 0
  return Math.round((p.progressScanned / p.progressTotal) * 100)
})

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtNullable(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return n.toFixed(3)
}

function fmtPct(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}

function fmtPctNullable(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return fmtPct(v)
}

function worstStyle(v: string | null | undefined): Record<string, string> {
  if (v === null || v === undefined) return {}
  const n = parseFloat(v)
  if (isNaN(n)) return {}
  return n < 0 ? { color: '#d03050' } : {}
}

function fmtTradeDate(s: string): string {
  if (!s || s.length !== 8) return s
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

function fmtRetPct(v: string): string {
  const n = parseFloat(v)
  if (isNaN(n)) return v
  return (n * 100).toFixed(2) + '%'
}

// ── Runs table ─────────────────────────────────────────────────────────────────

const selectedRunId = ref<string | null>(null)
const tradesLoading = ref(false)
const tradePage = ref(1)
const tradePageSize = 50

const trades = computed<SignalTestTrade[]>(() => {
  if (!selectedRunId.value) return []
  return store.tradesMap.get(selectedRunId.value)?.items ?? []
})

const tradeTotal = computed(() => {
  if (!selectedRunId.value) return 0
  return store.tradesMap.get(selectedRunId.value)?.total ?? 0
})

const tradePagination = computed(() => ({
  page: tradePage.value,
  pageSize: tradePageSize,
  itemCount: tradeTotal.value,
  showSizePicker: false,
}))

async function selectRun(runId: string) {
  selectedRunId.value = runId
  tradePage.value = 1
  await loadTrades()
}

async function loadTrades() {
  if (!selectedRunId.value) return
  tradesLoading.value = true
  try {
    await store.fetchTrades(selectedRunId.value, tradePage.value, tradePageSize)
  } finally {
    tradesLoading.value = false
  }
}

async function handlePageChange(page: number) {
  tradePage.value = page
  await loadTrades()
}

// Auto-select latest completed run when runs list changes
watch(runs, (newRuns) => {
  if (newRuns.length > 0 && !selectedRunId.value) {
    const completed = newRuns.find((r) => r.status === 'completed')
    if (completed) selectRun(completed.id)
  }
})

// Reset when test changes
watch(
  () => props.testId,
  () => {
    selectedRunId.value = null
    tradePage.value = 1
  },
)

const runColumns: DataTableColumns<SignalTestRun> = [
  {
    title: '运行时间',
    key: 'createdAt',
    render: (row) => {
      const d = new Date(row.createdAt)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render: (row) => {
      const typeMap: Record<string, 'success' | 'error' | 'info'> = {
        completed: 'success',
        failed: 'error',
        running: 'info',
      }
      const labelMap: Record<string, string> = {
        completed: '完成',
        failed: '失败',
        running: '运行中',
      }
      return h(NTag, { type: typeMap[row.status] ?? 'default', size: 'small' }, {
        default: () => labelMap[row.status] ?? row.status,
      })
    },
  },
  {
    title: '样本数',
    key: 'sampleCount',
    render: (row) => row.sampleCount ?? '—',
  },
  {
    title: '胜率',
    key: 'winRate',
    render: (row) => fmtPct(row.winRate),
  },
  {
    title: '赔率 b',
    key: 'payoffRatio',
    render: (row) => fmtNullable(row.payoffRatio),
  },
  {
    title: 'PF',
    key: 'profitFactor',
    render: (row) => fmtNullable(row.profitFactor),
  },
  {
    title: '凯利 f*',
    key: 'kellyF',
    render: (row) => fmtNullable(row.kellyF),
  },
  {
    title: '均持仓',
    key: 'avgHoldDays',
    render: (row) => fmtNullable(row.avgHoldDays),
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          type: row.id === selectedRunId.value ? 'primary' : 'default',
          onClick: () => selectRun(row.id),
          disabled: row.status !== 'completed',
        },
        { default: () => '查看明细' },
      ),
  },
]

const tradeColumns: DataTableColumns<SignalTestTrade> = [
  { title: '标的', key: 'tsCode', width: 110 },
  {
    title: '信号日',
    key: 'signalDate',
    render: (row) => fmtTradeDate(row.signalDate),
  },
  {
    title: '买入日',
    key: 'buyDate',
    render: (row) => fmtTradeDate(row.buyDate),
  },
  {
    title: '出场日',
    key: 'exitDate',
    render: (row) => fmtTradeDate(row.exitDate),
  },
  {
    title: '买入价',
    key: 'buyPrice',
    render: (row) => parseFloat(row.buyPrice).toFixed(3),
  },
  {
    title: '出场价',
    key: 'exitPrice',
    render: (row) => parseFloat(row.exitPrice).toFixed(3),
  },
  {
    title: '收益率',
    key: 'ret',
    render: (row) => {
      const n = parseFloat(row.ret)
      const color = n >= 0 ? '#18a058' : '#d03050'
      return h('span', { style: { color } }, fmtRetPct(row.ret))
    },
  },
  { title: '持仓天数', key: 'holdDays' },
  {
    title: '出场原因',
    key: 'exitReason',
    render: (row) => {
      const labelMap: Record<string, string> = {
        max_hold: '强平',
        signal: '信号',
        delist: '退市',
      }
      return labelMap[row.exitReason] ?? row.exitReason
    },
  },
]
</script>

<style scoped>
.signal-stats-result {
  padding: 0;
}

.progress-section {
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-label {
  font-size: 13px;
  color: var(--n-text-color-2, #666);
  white-space: nowrap;
}

.metrics-grid {
  margin-bottom: 16px;
}

:deep(.run-row--selected td) {
  background: color-mix(in srgb, var(--color-primary, #2080f0) 8%, transparent);
}
</style>
