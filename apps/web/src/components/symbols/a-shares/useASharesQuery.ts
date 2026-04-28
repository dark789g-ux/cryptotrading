import { computed, ref } from 'vue'
import type { DataTableSortState } from 'naive-ui'
import {
  aSharesApi,
  type AShareFilterPreset,
  type ASharePriceMode,
  type AShareRow,
  type AShareSummary,
} from '@/api'
import { formatTradeDate } from './aSharesFormatters'
import type { ASharesFilterState, Condition, SelectOption, SummaryItem } from './types'

export function useASharesQuery(message: {
  error: (content: string) => void
  success?: (content: string) => void
}) {
  const loading = ref(false)
  const filterPresetsLoading = ref(false)
  const rows = ref<AShareRow[]>([])
  const filterPresets = ref<AShareFilterPreset[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(10)
  const searchQuery = ref('')
  const selectedMarket = ref<string | null>(null)
  const selectedIndustry = ref<string | null>(null)
  const priceMode = ref<ASharePriceMode>('qfq')
  const pctChangeMin = ref<number | null>(null)
  const turnoverRateMin = ref<number | null>(null)
  const advancedConditions = ref<Condition[]>([])
  const sortKey = ref<string | null>(null)
  const sortOrder = ref<'ascend' | 'descend' | null>(null)
  const summary = ref<AShareSummary>({
    totalSymbols: '0',
    latestTradeDate: null,
    upCount: '0',
    downCount: '0',
    quotedCount: '0',
  })
  const marketOptions = ref<SelectOption[]>([])
  const industryOptions = ref<SelectOption[]>([])

  const paginationState = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
    showSizePicker: true,
    pageSizes: [10, 20, 50],
    prefix: () => `Total ${total.value}`,
  }))

  const summaryItems = computed<SummaryItem[]>(() => [
    { label: '股票总数', value: summary.value.totalSymbols, note: '上市状态 L', className: '' },
    { label: '最新交易日', value: formatTradeDate(summary.value.latestTradeDate), note: '本地最新快照', className: '' },
    { label: '上涨数量', value: summary.value.upCount, note: `报价 ${summary.value.quotedCount}`, className: 'trend-up' },
    { label: '下跌数量', value: summary.value.downCount, note: `报价 ${summary.value.quotedCount}`, className: 'trend-down' },
  ])

  function buildConditions(): Condition[] {
    const conditions: Condition[] = []
    if (pctChangeMin.value != null) conditions.push({ field: 'pctChg', op: 'gte', value: pctChangeMin.value })
    if (turnoverRateMin.value != null) conditions.push({ field: 'turnoverRate', op: 'gte', value: turnoverRateMin.value })
    conditions.push(...advancedConditions.value)
    return conditions
  }

  function buildFilterState(): ASharesFilterState {
    return {
      searchQuery: searchQuery.value,
      selectedMarket: selectedMarket.value,
      selectedIndustry: selectedIndustry.value,
      priceMode: priceMode.value,
      pctChangeMin: pctChangeMin.value,
      turnoverRateMin: turnoverRateMin.value,
      advancedConditions: advancedConditions.value.map((condition) => ({ ...condition })),
    }
  }

  function applyFilterState(filters: ASharesFilterState) {
    searchQuery.value = filters.searchQuery
    selectedMarket.value = filters.selectedMarket
    selectedIndustry.value = filters.selectedIndustry
    priceMode.value = filters.priceMode
    pctChangeMin.value = filters.pctChangeMin
    turnoverRateMin.value = filters.turnoverRateMin
    advancedConditions.value = filters.advancedConditions.map((condition) => ({ ...condition }))
  }

  async function loadData() {
    loading.value = true
    try {
      const res = await aSharesApi.query({
        page: page.value,
        pageSize: pageSize.value,
        q: searchQuery.value,
        market: selectedMarket.value,
        industry: selectedIndustry.value,
        priceMode: priceMode.value,
        sort: { field: sortKey.value ?? 'tsCode', order: sortOrder.value },
        conditions: buildConditions(),
      })
      rows.value = res.rows
      total.value = res.total
    } catch (err: unknown) {
      message.error(String(err))
    } finally {
      loading.value = false
    }
  }

  async function loadSummary() {
    try {
      summary.value = await aSharesApi.getSummary()
    } catch {
      summary.value = { totalSymbols: '0', latestTradeDate: null, upCount: '0', downCount: '0', quotedCount: '0' }
    }
  }

  async function loadFilterOptions() {
    try {
      const options = await aSharesApi.getFilterOptions()
      marketOptions.value = options.markets.map((item) => ({ label: item.value, value: item.value }))
      industryOptions.value = options.industries.map((item) => ({ label: item.value, value: item.value }))
    } catch {
      marketOptions.value = []
      industryOptions.value = []
    }
  }

  async function loadFilterPresets() {
    filterPresetsLoading.value = true
    try {
      filterPresets.value = await aSharesApi.listFilterPresets()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '加载筛选方案失败')
    } finally {
      filterPresetsLoading.value = false
    }
  }

  async function reload() {
    await Promise.all([loadSummary(), loadFilterOptions(), loadFilterPresets(), loadData()])
  }

  function applyFilters() {
    page.value = 1
    void loadData()
  }

  function resetFilters() {
    searchQuery.value = ''
    selectedMarket.value = null
    selectedIndustry.value = null
    pctChangeMin.value = null
    turnoverRateMin.value = null
    advancedConditions.value = []
    priceMode.value = 'qfq'
    page.value = 1
    void loadData()
  }

  async function createFilterPreset(name: string) {
    try {
      await aSharesApi.createFilterPreset({ name, filters: buildFilterState() })
      message.success?.(`已保存筛选方案 "${name}"`)
      await loadFilterPresets()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '保存筛选方案失败')
    }
  }

  async function overwriteFilterPreset(preset: AShareFilterPreset) {
    try {
      await aSharesApi.updateFilterPreset(preset.id, { filters: buildFilterState() })
      message.success?.(`已覆盖筛选方案 "${preset.name}"`)
      await loadFilterPresets()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '覆盖筛选方案失败')
    }
  }

  async function renameFilterPreset(preset: AShareFilterPreset, name: string) {
    try {
      await aSharesApi.updateFilterPreset(preset.id, { name })
      message.success?.('重命名成功')
      await loadFilterPresets()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '重命名筛选方案失败')
    }
  }

  async function deleteFilterPreset(preset: AShareFilterPreset) {
    try {
      await aSharesApi.deleteFilterPreset(preset.id)
      message.success?.(`已删除筛选方案 "${preset.name}"`)
      await loadFilterPresets()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '删除筛选方案失败')
    }
  }

  function applyFilterPreset(preset: AShareFilterPreset) {
    applyFilterState(preset.filters)
    page.value = 1
    message.success?.(`已套用筛选方案 "${preset.name}"`)
    void loadData()
  }

  function handlePriceModeChange() {
    page.value = 1
    void loadData()
  }

  function handlePageChange(nextPage: number) {
    page.value = nextPage
    void loadData()
  }

  function handlePageSizeChange(nextPageSize: number) {
    pageSize.value = nextPageSize
    page.value = 1
    void loadData()
  }

  function handleSort(sorter: DataTableSortState | DataTableSortState[] | null) {
    const state = Array.isArray(sorter) ? sorter[0] : sorter
    sortKey.value = typeof state?.columnKey === 'string' ? state.columnKey : null
    sortOrder.value = state?.order || null
    void loadData()
  }

  return {
    loading,
    filterPresetsLoading,
    rows,
    filterPresets,
    searchQuery,
    selectedMarket,
    selectedIndustry,
    priceMode,
    pctChangeMin,
    turnoverRateMin,
    advancedConditions,
    marketOptions,
    industryOptions,
    paginationState,
    summaryItems,
    reload,
    loadFilterPresets,
    applyFilters,
    resetFilters,
    createFilterPreset,
    overwriteFilterPreset,
    renameFilterPreset,
    deleteFilterPreset,
    applyFilterPreset,
    handlePriceModeChange,
    handlePageChange,
    handlePageSizeChange,
    handleSort,
  }
}
