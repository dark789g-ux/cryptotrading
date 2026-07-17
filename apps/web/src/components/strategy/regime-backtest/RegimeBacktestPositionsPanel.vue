<template>
  <div class="positions-panel">
    <n-tabs type="line" size="small">
      <n-tab-pane name="positions" tab="仓位记录">
        <n-spin :show="positionsLoading">
          <n-data-table
            :columns="positionColumns"
            :data="positions.items"
            :bordered="false"
            size="small"
            :pagination="positionPagination"
            :scroll-x="1000"
            @update:page="onPositionPage"
          />
        </n-spin>
      </n-tab-pane>
      <n-tab-pane name="symbols" tab="标的统计">
        <n-spin :show="symbolsLoading">
          <n-data-table
            :columns="symbolColumns"
            :data="symbols.items"
            :bordered="false"
            size="small"
            :pagination="symbolPagination"
            :scroll-x="900"
            @update:page="onSymbolPage"
          />
        </n-spin>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { NDataTable, NSpin, NTabs, NTabPane, type DataTableColumns, type PaginationProps } from 'naive-ui'
import {
  regimeBacktestApi,
  type RegimeBacktestPositionRow,
  type RegimeBacktestSymbolStatRow,
  type RegimeRowsPage,
} from '@/api/modules/strategy/regimeEngine'
import { formatTradeDate } from '@/components/symbols/a-shares/aSharesFormatters'
import { fmtPct } from '@/utils/format'

const props = defineProps<{
  runId: string | null
  active: boolean
}>()

const emit = defineEmits<{
  openKline: [payload: { tsCode: string; signalDate: string }]
}>()

const positionsLoading = ref(false)
const symbolsLoading = ref(false)
const positions = ref<RegimeRowsPage<RegimeBacktestPositionRow>>({
  total: 0,
  page: 1,
  pageSize: 20,
  items: [],
})
const symbols = ref<RegimeRowsPage<RegimeBacktestSymbolStatRow>>({
  total: 0,
  page: 1,
  pageSize: 20,
  items: [],
})

const positionPagination = computed<PaginationProps>(() => ({
  page: positions.value.page,
  pageSize: positions.value.pageSize,
  itemCount: positions.value.total,
  showSizePicker: false,
}))

const symbolPagination = computed<PaginationProps>(() => ({
  page: symbols.value.page,
  pageSize: symbols.value.pageSize,
  itemCount: symbols.value.total,
  showSizePicker: false,
}))

function fmtMoney(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

const positionColumns: DataTableColumns<RegimeBacktestPositionRow> = [
  {
    title: '标的',
    key: 'tsCode',
    width: 110,
    render: (row) =>
      h(
        'a',
        {
          style: 'cursor:pointer;color:var(--n-primary-color)',
          onClick: () => emit('openKline', { tsCode: row.tsCode, signalDate: row.signalDate }),
        },
        row.tsCode,
      ),
  },
  { title: '信号日', key: 'signalDate', width: 110, render: (r) => formatTradeDate(r.signalDate) },
  { title: '买入', key: 'buyDate', width: 110, render: (r) => formatTradeDate(r.buyDate) },
  { title: '卖出', key: 'exitDate', width: 110, render: (r) => (r.exitDate ? formatTradeDate(r.exitDate) : '—') },
  { title: '仓位', key: 'alloc', width: 100, render: (r) => fmtMoney(r.alloc) },
  { title: '收益', key: 'ret', width: 88, render: (r) => fmtPct(r.ret) },
  { title: '净收益', key: 'realizedRetNet', width: 88, render: (r) => fmtPct(r.realizedRetNet) },
  { title: '阶段', key: 'tradePhase', width: 72, render: (r) => r.tradePhase ?? '—' },
]

const symbolColumns: DataTableColumns<RegimeBacktestSymbolStatRow> = [
  { title: '标的', key: 'tsCode', width: 110 },
  { title: '成交笔数', key: 'tradeCount', width: 90 },
  { title: '胜', key: 'winCount', width: 56 },
  { title: '负', key: 'lossCount', width: 56 },
  { title: '总仓位', key: 'totalAlloc', width: 110, render: (r) => fmtMoney(r.totalAlloc) },
  { title: '总盈亏', key: 'totalPnl', width: 110, render: (r) => fmtMoney(r.totalPnl) },
  { title: '均收益', key: 'avgRet', width: 88, render: (r) => fmtPct(r.avgRet) },
  { title: '均净收益', key: 'avgRealizedRetNet', width: 96, render: (r) => fmtPct(r.avgRealizedRetNet) },
]

async function loadPositions(page = 1): Promise<void> {
  if (!props.runId) return
  positionsLoading.value = true
  try {
    positions.value = await regimeBacktestApi.listPositions(props.runId, { page, pageSize: 20 })
  } finally {
    positionsLoading.value = false
  }
}

async function loadSymbols(page = 1): Promise<void> {
  if (!props.runId) return
  symbolsLoading.value = true
  try {
    symbols.value = await regimeBacktestApi.listSymbolStats(props.runId, {
      page,
      pageSize: 20,
      sortBy: 'totalPnl',
      sortOrder: 'desc',
    })
  } finally {
    symbolsLoading.value = false
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([loadPositions(), loadSymbols()])
}

function onPositionPage(page: number): void {
  void loadPositions(page)
}

function onSymbolPage(page: number): void {
  void loadSymbols(page)
}

watch(
  () => [props.runId, props.active] as const,
  ([id, active]) => {
    if (id && active) void loadAll()
  },
  { immediate: true },
)
</script>

<style scoped>
.positions-panel {
  min-height: 200px;
}
</style>
