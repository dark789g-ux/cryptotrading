<template>
  <div class="watchlist-table">
    <!-- 工具栏 -->
    <div class="table-toolbar">
      <n-button
        v-if="store.currentId"
        type="primary"
        @click="showAddModal = true"
      >
        <template #icon>
          <n-icon><add-outline /></n-icon>
        </template>
        添加
      </n-button>
      <n-button @click="refreshQuotes">
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

    <!-- 列设置 -->
    <watchlist-table-settings :show="showSettings" @update:show="showSettings = $event" />

    <!-- 添加标的弹窗 -->
    <watchlist-add-symbols-modal
      v-if="store.currentId"
      :show="showAddModal"
      :watchlist="store.currentWatchlist"
      @update:show="showAddModal = $event"
      @added="onSymbolsAdded"
    />

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
            <kline-chart
              v-else
              :data="klineData"
              height="100%"
              :slider-start="35"
              show-toolbar
              :granularity="watchlistGranularity"
              :range="null"
              disabled-range
              prefs-key="watchlist"
              :available-subplots="watchlistAvailableSubplots"
            />
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton, NDataTable, NDrawer, NDrawerContent, NEmpty, NIcon, NSpin, NTag,
  type DataTableSortState,
} from 'naive-ui'
import { AddOutline, RefreshOutline, SettingsOutline } from '@vicons/ionicons5'
import { useWatchlistStore } from '@/stores/watchlist'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'
import {
  aSharesApi,
  klinesApi,
  quantApi,
  watchlistApi,
  type KlineChartBar,
  type WatchlistQuoteRow,
} from '@/api'
import { strategyConditionsApi } from '@/api/modules/strategy/strategyConditions'
import WatchlistAddSymbolsModal from './WatchlistAddSymbolsModal.vue'
import WatchlistTableSettings from './WatchlistTableSettings.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { createWatchlistColumnDefs, isWatchlistAShare } from './watchlistColumnDefs'
import { useWatchlistColumnPreferences } from '@/composables/watchlist/useWatchlistColumnPreferences'

const store = useWatchlistStore()
const strategyStore = useStrategyConditionsStore()
const showSettings = ref(false)
const showAddModal = ref(false)
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const klineData = ref<KlineChartBar[]>([])
const loadingKline = ref(false)
const scoresMap = ref(new Map<string, number>())
const scoresLoading = ref(false)
const hitLookup = ref(new Map<string, Set<string>>())

const watchlistAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']
const watchlistGranularity = computed<'date' | 'hour' | 'minute'>(() => {
  if (!selectedSymbol.value) return 'date'
  if (isWatchlistAShare(selectedSymbol.value)) return 'date'
  return store.interval === '1d' ? 'date' : 'hour'
})

const columnDefs = computed(() => createWatchlistColumnDefs({
  scoresMap,
  scoresLoading,
  hitLookup,
  onViewChart: openChart,
  onRemove: removeSymbol,
}))

const { columns } = useWatchlistColumnPreferences(columnDefs)

const paginationState = computed(() => ({
  page: store.page,
  pageSize: store.pageSize,
  itemCount: store.total,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `Total ${store.total}`,
}))

function resolveTradeDate(row: WatchlistQuoteRow): string | null {
  if (row.tradeDate && row.tradeDate.length === 8) return row.tradeDate
  if (row.openTime == null) return null
  const d = row.openTime instanceof Date ? row.openTime : new Date(row.openTime)
  if (isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

async function loadScores(currentRows: WatchlistQuoteRow[]) {
  const groups = new Map<string, string[]>()
  for (const row of currentRows) {
    if (!isWatchlistAShare(row.symbol)) continue
    const tradeDate = resolveTradeDate(row)
    if (!tradeDate) continue
    const list = groups.get(tradeDate) ?? []
    list.push(row.symbol)
    groups.set(tradeDate, list)
  }
  if (groups.size === 0) {
    scoresMap.value = new Map()
    return
  }
  scoresLoading.value = true
  try {
    const next = new Map<string, number>()
    await Promise.all(
      [...groups.entries()].map(async ([tradeDate, tsCodes]) => {
        const res = await quantApi.getScoresByTsCodes({ trade_date: tradeDate, ts_codes: tsCodes })
        for (const item of res.items) next.set(item.ts_code, item.score)
      }),
    )
    scoresMap.value = next
  } catch (err: unknown) {
    console.warn('[watchlist] 加载评分失败（不影响主表）:', err)
    scoresMap.value = new Map()
  } finally {
    scoresLoading.value = false
  }
}

async function loadHitLookup() {
  const newLookup = new Map<string, Set<string>>()
  for (const condition of strategyStore.conditions) {
    if (condition.targetType !== 'a-share') continue
    const status = strategyStore.runStatuses.get(condition.id)
    if (!status || status.freshness !== 'fresh') continue
    try {
      const result = await strategyConditionsApi.getRunResult(condition.id)
      for (const hit of result.hits) {
        const names = newLookup.get(hit.tsCode) ?? new Set<string>()
        names.add(condition.name)
        newLookup.set(hit.tsCode, names)
      }
    } catch { /* ignore */ }
  }
  hitLookup.value = newLookup
}

async function refreshQuotes() {
  await store.loadQuotes()
  void loadScores(store.quotes)
}

watch(
  () => store.quotes,
  (rows) => {
    void loadScores(rows)
  },
  { immediate: true },
)

watch(
  () => store.currentId,
  async () => {
    await strategyStore.fetchConditions('a-share')
    await strategyStore.fetchLastRunStatus()
    await loadHitLookup()
  },
  { immediate: true },
)

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
    klineData.value = isWatchlistAShare(symbol)
      ? await aSharesApi.getKlines(symbol, 360, 'qfq')
      : await klinesApi.getKlines(symbol, store.interval)
  } catch (err: unknown) {
    console.error(err)
  } finally {
    loadingKline.value = false
  }
}

async function onSymbolsAdded() {
  await store.loadWatchlists()
  await store.loadQuotes()
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
