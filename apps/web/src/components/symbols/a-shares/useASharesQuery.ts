import { computed, ref } from 'vue'
import type { DataTableSortState } from 'naive-ui'
import {
  aSharesApi,
  type AShareFilterPreset,
  type ASharePriceMode,
  type AShareRow,
  type AShareSummary,
} from '@/api'
import { quantApi } from '@/api/modules/quant'
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'
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
  const selectedSwIndustryL1Code = ref<string | null>(null)
  const selectedSwIndustryL2Code = ref<string | null>(null)
  const selectedSwIndustryL3Code = ref<string | null>(null)
  const priceMode = ref<ASharePriceMode>('qfq')
  const pctChangeMin = ref<number | null>(null)
  const turnoverRateMin = ref<number | null>(null)
  const advancedConditions = ref<Condition[]>([])
  const selectedStrategyIds = ref<string[]>([])
  const indexFilter = ref<{ tsCode: string; name: string } | null>(null)
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
  const swIndustryL1Options = ref<SelectOption[]>([])
  const swIndustryL2Options = ref<SelectOption[]>([])
  const swIndustryL3Options = ref<SelectOption[]>([])
  // 评分列：tsCode → score。整体替换触发列 render 重算；缺失的 tsCode 不进 Map（显示 —）
  const scoresMap = ref<Map<string, number>>(new Map())
  const scoresLoading = ref(false)
  const latestTradeDate = computed(() => summary.value.latestTradeDate)

  const {
    selectedWatchlistIds,
    watchlistOptions,
    watchlistIds,
    resetWatchlistFilter,
    ensureWatchlistsLoaded,
  } = useWatchlistTagFilter()

  const paginationState = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
    showSizePicker: true,
    pageSizes: [10, 20, 50],
    prefix: () => `Total ${total.value}`,
  }))

  // 分栏左栏宽度窄，用精简分页器（仅前后翻页 + 页码输入 + prefix 总数），
  // 去掉 size picker（naive-ui simple 模式下自动跳过），避免看不全
  const splitPaginationState = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
    simple: true,
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
      selectedSwIndustryL1Code: selectedSwIndustryL1Code.value,
      selectedSwIndustryL2Code: selectedSwIndustryL2Code.value,
      selectedSwIndustryL3Code: selectedSwIndustryL3Code.value,
      priceMode: priceMode.value,
      pctChangeMin: pctChangeMin.value,
      turnoverRateMin: turnoverRateMin.value,
      advancedConditions: advancedConditions.value.map((condition) => ({ ...condition })),
    }
  }

  function applyFilterState(filters: ASharesFilterState) {
    searchQuery.value = filters.searchQuery
    selectedMarket.value = filters.selectedMarket
    selectedSwIndustryL1Code.value = filters.selectedSwIndustryL1Code ?? null
    selectedSwIndustryL2Code.value = filters.selectedSwIndustryL2Code ?? null
    selectedSwIndustryL3Code.value = filters.selectedSwIndustryL3Code ?? null
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
        swIndustryL1Code: selectedSwIndustryL1Code.value,
        swIndustryL2Code: selectedSwIndustryL2Code.value,
        swIndustryL3Code: selectedSwIndustryL3Code.value,
        priceMode: priceMode.value,
        watchlistIds: watchlistIds.value,
        sort: { field: sortKey.value ?? 'tsCode', order: sortOrder.value },
        conditions: buildConditions(),
        strategyHitIds: selectedStrategyIds.value,
        indexTsCode: indexFilter.value?.tsCode,
      })
      rows.value = res.rows
      total.value = res.total
    } catch (err: unknown) {
      message.error(String(err))
    } finally {
      loading.value = false
    }
    // 主表先呈现，评分异步回填；用 res 的行做防竞态（不读后续可能已变的 rows.value）
    void loadScores(rows.value)
  }

  /**
   * 拉取当前页标的"当日 prod 模型"评分，整体替换 scoresMap。
   * fire-and-forget：失败不弹 toast、不阻塞主表（评分是次要列），仅 console.warn 留痕。
   */
  async function loadScores(currentRows: AShareRow[]) {
    const tradeDate = summary.value.latestTradeDate
    const tsCodes = currentRows.map((r) => r.tsCode)
    if (!tradeDate || tsCodes.length === 0) {
      scoresMap.value = new Map()
      return
    }
    scoresLoading.value = true
    try {
      const res = await quantApi.getScoresByTsCodes({ trade_date: tradeDate, ts_codes: tsCodes })
      const next = new Map<string, number>()
      for (const item of res.items) next.set(item.ts_code, item.score)
      scoresMap.value = next
    } catch (err: unknown) {
      console.warn('[aShares] 加载评分失败（不影响主表）:', err)
      scoresMap.value = new Map()
    } finally {
      scoresLoading.value = false
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
      marketOptions.value = options.markets.map((item) => ({ label: item.label, value: item.value }))
      swIndustryL1Options.value = options.swIndustriesL1.map((item) => ({ label: item.label, value: item.value }))
      swIndustryL2Options.value = options.swIndustriesL2.map((item) => ({ label: item.label, value: item.value }))
      swIndustryL3Options.value = options.swIndustriesL3.map((item) => ({ label: item.label, value: item.value }))
    } catch {
      marketOptions.value = []
      swIndustryL1Options.value = []
      swIndustryL2Options.value = []
      swIndustryL3Options.value = []
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
    await Promise.all([ensureWatchlistsLoaded(), loadSummary(), loadFilterOptions(), loadFilterPresets(), loadData()])
    // 首屏 loadData 与 loadSummary 并行，loadData 内首次 loadScores 时 latestTradeDate 可能尚未到位被跳过；
    // 此处 summary 已就绪，用最新 rows 补一次（幂等、整体替换）
    void loadScores(rows.value)
  }

  function applyFilters() {
    page.value = 1
    void loadData()
  }

  function applyIndexFilter(tsCode: string, name: string) {
    rows.value = []
    loading.value = true
    indexFilter.value = { tsCode, name }
    page.value = 1
    void loadData()
  }

  function clearIndexFilter() {
    rows.value = []
    loading.value = true
    indexFilter.value = null
    page.value = 1
    void loadData()
  }

  function resetFilters() {
    searchQuery.value = ''
    selectedMarket.value = null
    selectedSwIndustryL1Code.value = null
    selectedSwIndustryL2Code.value = null
    selectedSwIndustryL3Code.value = null
    pctChangeMin.value = null
    turnoverRateMin.value = null
    advancedConditions.value = []
    selectedStrategyIds.value = []
    indexFilter.value = null
    priceMode.value = 'qfq'
    resetWatchlistFilter()
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
    selectedSwIndustryL1Code,
    selectedSwIndustryL2Code,
    selectedSwIndustryL3Code,
    selectedWatchlistIds,
    watchlistOptions,
    priceMode,
    pctChangeMin,
    turnoverRateMin,
    advancedConditions,
    selectedStrategyIds,
    indexFilter,
    marketOptions,
    swIndustryL1Options,
    swIndustryL2Options,
    swIndustryL3Options,
    paginationState,
    splitPaginationState,
    summaryItems,
    scoresMap,
    scoresLoading,
    latestTradeDate,
    reload,
    loadFilterPresets,
    applyFilters,
    resetFilters,
    applyIndexFilter,
    clearIndexFilter,
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
