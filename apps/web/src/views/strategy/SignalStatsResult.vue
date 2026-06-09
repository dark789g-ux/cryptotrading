<template>
  <div class="signal-stats-result">
    <!-- Config summary bar -->
    <div class="config-summary">
      <span>{{ exitModeLabel }}</span>
      <span class="dot">·</span>
      <span>{{ universeLabel }}</span>
      <span class="dot">·</span>
      <span>{{ dateRangeLabel }}</span>
      <span class="dot">·</span>
      <span>{{ conditionLabel }}</span>
    </div>

    <template v-if="latestRun">
      <!-- Running progress -->
      <div v-if="latestRun.status === 'running'" class="progress-section">
        <n-progress
          type="line"
          :percentage="progressPct"
          :indicator-placement="'inside'"
          :color="'#2080f0'"
          :height="20"
        />
        <span class="progress-label">
          扫描中 {{ latestRun.progressScanned }} / {{ latestRun.progressTotal }}
        </span>
      </div>

      <!-- Failed -->
      <n-alert
        v-if="latestRun.status === 'failed'"
        type="error"
        title="运行失败"
        :bordered="false"
        style="margin-bottom: 16px"
      >
        {{ latestRun.errorMessage ?? '未知错误' }}
      </n-alert>

      <!-- Completed: metrics + tabs -->
      <template v-if="latestRun.status === 'completed'">
        <n-grid :cols="5" :x-gap="12" :y-gap="12" class="metrics-grid">
          <n-grid-item>
            <n-statistic label="样本数">
              <span>{{ latestRun.sampleCount ?? '—' }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="胜率">
              <n-tooltip v-if="latestRun.winRate !== null" trigger="hover">
                <template #trigger>
                  <span>{{ fmtPct(latestRun.winRate) }}</span>
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
                  <span>{{ fmtNullable(latestRun.payoffRatio) }}</span>
                </template>
                <span v-if="latestRun.payoffRatio !== null">均盈 / |均亏|</span>
                <span v-else>无亏损样本，赔率无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="盈亏比 PF">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestRun.profitFactor) }}</span>
                </template>
                <span v-if="latestRun.profitFactor !== null">总盈利 / |总亏损|</span>
                <span v-else>无亏损样本，PF 无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="凯利 f*">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestRun.kellyF) }}</span>
                </template>
                <span v-if="latestRun.kellyF !== null">Kelly 最优仓位比例</span>
                <span v-else>无亏损样本，凯利无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均持仓天数">
              <span>{{ fmtNullable(latestRun.avgHoldDays) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均盈">
              <span>{{ fmtPctNullable(latestRun.avgWin) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均亏">
              <span>{{ fmtPctNullable(latestRun.avgLoss) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="最差单笔收益">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span :style="worstStyle(latestRun.worstTradeRet)">
                    {{ fmtPctNullable(latestRun.worstTradeRet) }}
                  </span>
                </template>
                历史最差单笔收益（min ret），全胜时可为正
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="最佳单笔收益">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span :style="bestStyle(latestRun.bestTradeRet)">
                    {{ fmtPctNullable(latestRun.bestTradeRet) }}
                  </span>
                </template>
                历史最佳单笔收益（max ret）
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
        </n-grid>

        <n-tabs v-model:value="activeTab" display-directive="show:lazy" type="line">
          <n-tab-pane name="histogram" tab="收益率分布">
            <RetHistogram :run-id="latestRun.id" />
          </n-tab-pane>
          <n-tab-pane name="trades" tab="逐笔明细">
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
          </n-tab-pane>
        </n-tabs>
      </template>
    </template>

    <n-empty v-else description="尚无运行结果" />
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
  NDataTable,
  NTabs,
  NTabPane,
  NEmpty,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useSignalStatsStore } from '../../stores/signalStats'
import type {
  SignalTestWithLatestRun,
  SignalTestTrade,
} from '../../api/modules/strategy/signalStats'
import RetHistogram from '../../components/strategy/RetHistogram.vue'

interface Props {
  test: SignalTestWithLatestRun
}

const props = defineProps<Props>()

const store = useSignalStatsStore()

const latestRun = computed(() => props.test.latestRun)

// ── Config summary ─────────────────────────────────────────────────────────────

const exitModeLabel = computed(() => {
  const t = props.test
  if (t.exitMode === 'fixed_n') return `固定${t.horizonN}日`
  if (t.exitMode === 'trailing_lock')
    return t.maxHold == null ? '波段跟踪止损' : `波段跟踪止损(≤${t.maxHold})`
  return `条件出场(≤${t.maxHold})`
})

const universeLabel = computed(() => {
  const u = props.test.universe
  return u.type === 'all' ? '全市场' : `指定${u.tsCodes?.length ?? 0}只`
})

const dateRangeLabel = computed(
  () => `${fmtTradeDate(props.test.dateStart)}~${fmtTradeDate(props.test.dateEnd)}`,
)

const conditionLabel = computed(
  () => `买${props.test.buyConditions.length}/卖${props.test.exitConditions?.length ?? 0}条`,
)

// ── Progress ────────────────────────────────────────────────────────────────────

const progressPct = computed(() => {
  const p = latestRun.value
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

function bestStyle(v: string | null | undefined): Record<string, string> {
  if (v === null || v === undefined) return {}
  const n = parseFloat(v)
  if (isNaN(n)) return {}
  return n > 0 ? { color: '#18a058' } : {}
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

// ── Tabs + trade detail ─────────────────────────────────────────────────────────

const activeTab = ref<'histogram' | 'trades'>('histogram')
const tradesLoaded = ref(false)
const tradesLoading = ref(false)
const tradePage = ref(1)
const tradePageSize = 50

const trades = computed<SignalTestTrade[]>(() => {
  const run = latestRun.value
  if (!run) return []
  return store.tradesMap.get(run.id)?.items ?? []
})

const tradeTotal = computed(() => {
  const run = latestRun.value
  if (!run) return 0
  return store.tradesMap.get(run.id)?.total ?? 0
})

const tradePagination = computed(() => ({
  page: tradePage.value,
  pageSize: tradePageSize,
  itemCount: tradeTotal.value,
  showSizePicker: false,
}))

async function loadTrades() {
  const run = latestRun.value
  if (!run) return
  tradesLoading.value = true
  try {
    await store.fetchTrades(run.id, tradePage.value, tradePageSize)
  } finally {
    tradesLoading.value = false
  }
}

async function handlePageChange(page: number) {
  tradePage.value = page
  await loadTrades()
}

// Lazy-load trade detail on first switch to the 'trades' tab.
watch(activeTab, (tab) => {
  if (tab === 'trades' && !tradesLoaded.value) {
    tradesLoaded.value = true
    loadTrades()
  }
})

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
        stop: '止损',
        ma5_exit: 'MA5离场',
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

.config-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 16px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--n-action-color, #f7f7fa);
  font-size: 13px;
  color: var(--n-text-color-2, #666);
}

.config-summary .dot {
  color: var(--n-text-color-3, #bbb);
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
</style>
