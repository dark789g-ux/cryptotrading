<!-- apps/web/src/components/money-flow/FlowTrendModal.vue -->
<template>
  <AppModal
    :show="visible"
    :title="`${entityName} — 详情`"
    :width="modalWidth"
    @update:show="$emit('update:visible', $event)"
  >
    <n-tabs v-model:value="activeTab" type="line" animated>
      <n-tab-pane name="trend" tab="趋势">
        <div class="trend-modal-body">
          <FlowDateControl
            :hide-mode-toggle="chartMode === 'kline'"
            default-mode="range"
            :default-range-days="chartMode === 'kline' ? 120 : 30"
            @change="onDateChange"
          />
          <n-spin v-if="loading" />
          <template v-else-if="chartMode === 'bar'">
            <FlowTrendChart :rows="barRows" />
          </template>
          <template v-else>
            <div v-if="!klineBars.length" class="empty-state">
              该指数暂无 K 线数据，可能尚未同步
            </div>
            <KlineChart
              v-else
              :data="klineBars"
              :money-flow="moneyFlowBars"
              height="520px"
            />
          </template>
        </div>
      </n-tab-pane>

      <n-tab-pane v-if="showMembersTab" name="members" tab="成分股">
        <div class="members-body">
          <div class="members-toolbar">
            <n-button type="primary" :disabled="!canAddTag" :loading="addTagLoading" @click="onAddTag">
              + 添加标签
            </n-button>
            <span class="hint">共 {{ memberRows.length }} 只</span>
          </div>
          <n-spin :show="membersLoading">
            <n-data-table
              :columns="memberColumns"
              :data="sortedMemberRows"
              :max-height="400"
              size="small"
              :pagination="{ pageSize: 50 }"
              @update:sorter="onUpdateSorter"
            />
            <div v-if="!membersLoading && !memberRows.length" class="empty-state">
              暂无成分股数据，请先同步资金流数据。
            </div>
          </n-spin>
        </div>
      </n-tab-pane>
    </n-tabs>

    <template #actions>
      <n-button @click="$emit('update:visible', false)">关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'FlowTrendModal' })

import { computed, h, ref, watch } from 'vue'
import { NButton, NDataTable, NSpin, NTabPane, NTabs, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendChart from './FlowTrendChart.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import { moneyFlowApi, type MoneyFlowMemberRow, type MoneyFlowQueryParams } from '@/api/modules/market/moneyFlow'
import { watchlistApi } from '@/api'
import type { KlineChartBar, MoneyFlowBar } from '@/api'
import { useWatchlistStore } from '@/stores/watchlist'
import type { BarChartRow, TrendFetchResult } from './money-flow.types'

type ChartMode = 'bar' | 'kline'

// fetchFn 的返回类型由调用方按 chartMode 自行约束：
// - bar 模式：返回 BarChartRow[]
// - kline 模式：返回 TrendFetchResult
// 这里用联合类型并在 loadTrend 内按 chartMode 分发。
type TrendFetchFn = (params: MoneyFlowQueryParams) => Promise<BarChartRow[] | TrendFetchResult>

const props = withDefaults(defineProps<{
  visible: boolean
  tsCode: string
  entityName: string
  fetchFn: TrendFetchFn
  chartMode?: ChartMode
  showMembersTab?: boolean
  membersTradeDate?: string | null
}>(), {
  chartMode: 'bar',
  showMembersTab: false,
  membersTradeDate: null,
})

defineEmits<{
  'update:visible': [value: boolean]
}>()

const message = useMessage()

const modalWidth = computed(() =>
  props.chartMode === 'kline' ? 'min(1080px, 96vw)' : 'min(720px, 92vw)',
)

const activeTab = ref('trend')
const barRows = ref<BarChartRow[]>([])
const klineBars = ref<KlineChartBar[]>([])
const moneyFlowBars = ref<MoneyFlowBar[]>([])
const loading = ref(false)
let skipNextEmit = false

// 成分股相关
const memberRows = ref<MoneyFlowMemberRow[]>([])
const membersLoading = ref(false)
let membersLoaded = false

const sortState = ref<{ field: 'pctChange' | 'netAmount'; order: 'ascend' | 'descend' } | null>({
  field: 'netAmount',
  order: 'descend',
})

function compareWithNullsLast(
  a: number | null | undefined,
  b: number | null | undefined,
  order: 'ascend' | 'descend',
) {
  const aNull = a == null || !Number.isFinite(Number(a))
  const bNull = b == null || !Number.isFinite(Number(b))
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  const x = Number(a)
  const y = Number(b)
  return order === 'descend' ? y - x : x - y
}

const sortedMemberRows = computed(() => {
  if (!sortState.value) return memberRows.value
  const { field, order } = sortState.value
  return [...memberRows.value].sort((r1, r2) =>
    compareWithNullsLast(r1[field] as number | null | undefined, r2[field] as number | null | undefined, order),
  )
})

const memberColumns = computed((): DataTableColumns<MoneyFlowMemberRow> => [
  {
    title: '#',
    key: 'index',
    width: 50,
    render: (_row, index) => h('span', {}, String(index + 1)),
  },
  { title: '代码', key: 'conCode', width: 120 },
  { title: '名称', key: 'conName', width: 150 },
  {
    title: '涨跌幅%',
    key: 'pctChange',
    width: 90,
    sorter: true,
    sortOrder: sortState.value?.field === 'pctChange' ? sortState.value.order : (false as const),
    render: (row) => {
      if (row.pctChange == null) return h('span', {}, '—')
      const v = Number(row.pctChange)
      return h(
        'span',
        { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' },
        `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
      )
    },
  },
  {
    title: '净流入(亿)',
    key: 'netAmount',
    width: 110,
    sorter: true,
    sortOrder: sortState.value?.field === 'netAmount' ? sortState.value.order : (false as const),
    render: (row) => {
      if (row.netAmount == null) return h('span', {}, '—')
      const v = Number(row.netAmount)
      return h(
        'span',
        { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' },
        v.toFixed(2),
      )
    },
  },
])

function onUpdateSorter(sorter: { columnKey: string; order: 'ascend' | 'descend' | false } | null) {
  if (!sorter || !sorter.order) {
    sortState.value = null
    return
  }
  if (sorter.columnKey === 'pctChange' || sorter.columnKey === 'netAmount') {
    sortState.value = { field: sorter.columnKey, order: sorter.order }
  }
}

// 添加标签
const addTagLoading = ref(false)
const canAddTag = computed(() => memberRows.value.length > 0 && !!props.entityName?.trim())

async function onAddTag() {
  if (!canAddTag.value) return
  addTagLoading.value = true
  try {
    const res = await watchlistApi.upsertByName({
      name: props.entityName.trim(),
      symbols: memberRows.value.map((r) => r.conCode),
    })
    const msg = res.created
      ? `已新建标签「${res.name}」，加入 ${res.added} 只`
      : `已加入「${res.name}」：新增 ${res.added} 只，跳过已存在 ${res.skipped} 只`
    message.success(msg)
    try {
      await useWatchlistStore().loadWatchlists()
    } catch {
      /* ignore */
    }
  } catch (err: any) {
    message.error(err?.message || '添加标签失败')
  } finally {
    addTagLoading.value = false
  }
}

function resetTrendState() {
  barRows.value = []
  klineBars.value = []
  moneyFlowBars.value = []
}

async function loadTrend(params: MoneyFlowQueryParams) {
  loading.value = true
  try {
    const result = await props.fetchFn({ ...params, ts_code: props.tsCode })
    if (props.chartMode === 'bar') {
      barRows.value = result as BarChartRow[]
      klineBars.value = []
      moneyFlowBars.value = []
    } else {
      const r = result as TrendFetchResult
      klineBars.value = r.kline ?? []
      moneyFlowBars.value = r.moneyFlow ?? []
      barRows.value = []
    }
  } catch {
    resetTrendState()
  } finally {
    loading.value = false
  }
}

async function loadLatest() {
  // 大盘 / bar 模式：保留原有 limit=30 取最近 30 条的语义
  if (props.chartMode === 'bar') {
    loading.value = true
    try {
      const result = await props.fetchFn({ ts_code: props.tsCode, limit: 30 })
      const data = result as BarChartRow[]
      barRows.value = [...data].reverse()
      klineBars.value = []
      moneyFlowBars.value = []
    } catch {
      resetTrendState()
    } finally {
      loading.value = false
    }
    return
  }
  // kline 模式不在此处主动加载——首次进入由 FlowDateControl 的初始 emit 触发 loadTrend
  resetTrendState()
}

function onDateChange(params: MoneyFlowQueryParams) {
  if (skipNextEmit) {
    skipNextEmit = false
    return
  }
  loadTrend(params)
}

async function loadMembers() {
  if (membersLoaded) return
  membersLoading.value = true
  try {
    memberRows.value = await moneyFlowApi.getMembers(props.tsCode, props.membersTradeDate ?? undefined)
    membersLoaded = true
  } catch {
    memberRows.value = []
  } finally {
    membersLoading.value = false
  }
}

watch(() => props.visible, (v) => {
  if (v) {
    resetTrendState()
    memberRows.value = []
    membersLoaded = false
    activeTab.value = 'trend'
    sortState.value = { field: 'netAmount', order: 'descend' }
    // bar 模式：直接拉最近 30 条柱状数据，跳过 FlowDateControl 初始 emit
    // kline 模式：依赖 FlowDateControl 初始 emit 的 [今天-120d, 今天] 范围
    if (props.chartMode === 'bar') {
      skipNextEmit = true
      loadLatest()
    }
  }
})

watch(activeTab, (tab) => {
  if (tab === 'members' && props.showMembersTab) {
    loadMembers()
  }
})
</script>

<style scoped>
.trend-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.members-body {
  min-height: 200px;
}
.members-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.members-toolbar .hint {
  color: var(--color-text-muted);
  font-size: 12px;
}
.empty-state {
  color: var(--color-text-muted);
  text-align: center;
  padding: 40px;
}
:deep(.positive) {
  color: #f04747;
}
:deep(.negative) {
  color: #4caf8a;
}
</style>
