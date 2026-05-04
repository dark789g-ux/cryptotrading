<template>
  <div class="watchlist-table">
    <!-- 工具栏 -->
    <div class="table-toolbar">
      <n-button @click="store.loadQuotes">
        <template #icon>
          <n-icon><refresh-outline /></n-icon>
        </template>
        刷新
      </n-button>
      <n-button @click="showSettings = true">
        <template #icon>
          <n-icon><settings-outline /></n-icon>
        </template>
        列设置
      </n-button>
    </div>

    <!-- 表格 -->
    <n-data-table
      :columns="columns"
      :data="store.quotes"
      :loading="store.loadingQuotes"
      :pagination="paginationState"
      remote
      @update:page="handlePageChange"
      @update:page-size="handlePageSizeChange"
      @update:sorter="handleSort"
    />

    <!-- 列设置抽屉 -->
    <watchlist-table-settings :show="showSettings" @update:show="showSettings = $event" />

    <!-- K 线抽屉 -->
    <n-drawer
      v-model:show="showChartDrawer"
      width="min(1440px, 96vw)"
      placement="right"
    >
      <n-drawer-content class="kline-detail-drawer" closable>
        <template #header>
          <div v-if="selectedSymbol" class="drawer-title">
            <div class="symbol-line">
              <span class="symbol-name">{{ selectedSymbol }}</span>
              <n-tag size="small" :bordered="false">{{ store.interval.toUpperCase() }}</n-tag>
            </div>
          </div>
          <span v-else>K 线详情</span>
        </template>

        <div class="detail-content">
          <div class="chart-panel">
            <div v-if="loadingKline" class="chart-center">
              <n-spin />
            </div>
            <n-empty v-else-if="!klineData.length" description="暂无 K 线数据" class="chart-empty" />
            <kline-chart v-else :data="klineData" height="100%" :slider-start="35" />
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import {
  NButton, NDataTable, NDrawer, NDrawerContent, NEmpty, NIcon, NSpin, NTag,
  type DataTableColumns, type DataTableSortState,
} from 'naive-ui'
import { RefreshOutline, SettingsOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { useWatchlistStore } from '@/stores/watchlist'
import { aSharesApi, klinesApi, watchlistApi, type KlineChartBar } from '@/api'
import WatchlistTableSettings from './WatchlistTableSettings.vue'
import KlineChart from '@/components/kline/KlineChart.vue'

const store = useWatchlistStore()
const showSettings = ref(false)
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const klineData = ref<KlineChartBar[]>([])
const loadingKline = ref(false)

const paginationState = computed(() => ({
  page: store.page,
  pageSize: store.pageSize,
  itemCount: store.total,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `Total ${store.total}`,
}))

function handlePageChange(nextPage: number) {
  store.page = nextPage
  store.loadQuotes()
}

function handlePageSizeChange(nextPageSize: number) {
  store.pageSize = nextPageSize
  store.page = 1
  store.loadQuotes()
}

function handleSort(sorter: DataTableSortState | DataTableSortState[] | null) {
  const state = Array.isArray(sorter) ? sorter[0] : sorter
  store.sortKey = typeof state?.columnKey === 'string' ? state.columnKey : null
  store.sortOrder = state?.order || null
  store.page = 1
  store.loadQuotes()
}

async function openChart(symbol: string) {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  loadingKline.value = true
  klineData.value = []
  try {
    klineData.value = isAShareSymbol(symbol)
      ? await aSharesApi.getKlines(symbol, 360, 'qfq')
      : await klinesApi.getKlines(symbol, store.interval)
  } catch (err: any) {
    console.error(err)
  } finally {
    loadingKline.value = false
  }
}

function isAShareSymbol(symbol: string) {
  return /^\d{6}\.(SZ|SH|BJ)$/.test(symbol)
}

async function removeSymbol(symbol: string) {
  if (!store.currentId) return
  const old = [...store.quotes]
  store.quotes = store.quotes.filter((q) => q.symbol !== symbol)
  try {
    await watchlistApi.removeSymbol(store.currentId, symbol)
    store.total -= 1
  } catch {
    store.quotes = old
  }
}

const formatFixed = (value: number | null | undefined, digits: number) =>
  value == null ? '-' : value.toFixed(digits)

const columns = computed<DataTableColumns<any>>(() => {
  const base: DataTableColumns<any> = [
    {
      title: 'Symbol',
      key: 'symbol',
      width: 160,
      fixed: 'left',
      sorter: true,
      render: (row) =>
        h('span', {
            style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          }, row.symbol),
    },
  ]

  const colMap: Record<string, any> = {
    close: { title: 'Close', key: 'close', width: 120, sorter: true, render: (row: any) => (row.close == null ? '-' : Number(row.close).toPrecision(6)) },
    ma5: { title: 'MA5', key: 'ma5', width: 110, sorter: true, render: (row: any) => formatFixed(row.ma5, 4) },
    ma30: { title: 'MA30', key: 'ma30', width: 110, sorter: true, render: (row: any) => formatFixed(row.ma30, 4) },
    ma60: { title: 'MA60', key: 'ma60', width: 110, sorter: true, render: (row: any) => formatFixed(row.ma60, 4) },
    kdjJ: { title: 'KDJ.J', key: 'kdjJ', width: 90, sorter: true, render: (row: any) => formatFixed(row.kdjJ, 2) },
    riskRewardRatio: { title: 'RR', key: 'riskRewardRatio', width: 90, sorter: true, render: (row: any) => formatFixed(row.riskRewardRatio, 2) },
    stopLossPct: { title: 'Stop %', key: 'stopLossPct', width: 90, sorter: true, render: (row: any) => (row.stopLossPct == null ? '-' : `${row.stopLossPct.toFixed(2)}%`) },
    openTime: { title: 'Updated', key: 'openTime', width: 110, sorter: true, render: (row: any) => (row.openTime ? new Date(row.openTime).toISOString().slice(0, 10) : '-') },
  }

  for (const key of store.columns) {
    if (colMap[key]) base.push(colMap[key])
  }

  base.push({
    title: 'Action',
    key: 'actions',
    width: 180,
    fixed: 'right',
    render: (row) =>
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
        h(NButton, {
          size: 'small',
          tertiary: true,
          onClick: () => openChart(row.symbol),
        }, {
          icon: () => h(NIcon, null, { default: () => h(TrendingUpOutline) }),
          default: () => '查看K线',
        }),
        h(NButton, {
          size: 'small',
          type: 'error',
          ghost: true,
          onClick: () => removeSymbol(row.symbol),
        }, {
          default: () => '移除',
        }),
      ]),
  })

  return base
})
</script>

<style scoped>
.watchlist-table {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.table-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}

.kline-detail-drawer :deep(.n-drawer-body) {
  flex: 1;
  min-height: 0;
}

.kline-detail-drawer :deep(.n-drawer-body-content-wrapper) {
  height: 100%;
  padding: 0;
}

.drawer-title {
  min-width: 0;
}

.symbol-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.symbol-name {
  color: var(--color-text);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-content,
.chart-panel {
  display: flex;
  flex: 1;
  height: 100%;
  min-height: 620px;
  min-width: 0;
}

.chart-center,
.chart-empty {
  align-items: center;
  display: flex;
  flex: 1;
  justify-content: center;
}

@media (max-width: 960px) {
  .detail-content,
  .chart-panel {
    min-height: 520px;
  }
}
</style>
