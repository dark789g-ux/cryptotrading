import { computed, ref, type Ref } from 'vue'
import type { DataTableSortState } from 'naive-ui'
import { symbolApi, type SymbolRow } from '@/api'
import type { NumericCondition } from '@/components/common/numericConditionFilterTypes'

export interface UseCryptoSymbolsQueryOptions {
  message: { error: (content: string) => void }
  interval: Ref<string>
  searchQuery: Ref<string>
  watchlistIds: Ref<string[] | undefined>
  selectedStrategyIds: Ref<string[]>
  conditions: Ref<NumericCondition[]>
}

export function useCryptoSymbolsQuery(options: UseCryptoSymbolsQueryOptions) {
  const { message, interval, searchQuery, watchlistIds, selectedStrategyIds, conditions } = options

  const loading = ref(false)
  const symbols = ref<SymbolRow[]>([])
  const total = ref(0)

  const page = ref(1)
  const pageSize = ref(20)
  const sortKey = ref<string | null>(null)
  const sortOrder = ref<'ascend' | 'descend' | null>(null)

  const pagination = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
  }))

  function buildQuery() {
    return {
      interval: interval.value,
      q: searchQuery.value,
      conditions: conditions.value,
      watchlistIds: watchlistIds.value,
      strategyHitIds: selectedStrategyIds.value,
      sort: { field: sortKey.value ?? 'symbol', asc: sortOrder.value !== 'descend' },
      page: page.value,
      page_size: pageSize.value,
    }
  }

  async function loadData() {
    loading.value = true
    try {
      const res = await symbolApi.query(buildQuery())
      symbols.value = res.items as SymbolRow[]
      total.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      loading.value = false
    }
  }

  function applyFilters() {
    page.value = 1
    return loadData()
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

  function handleSorterChange(sorter: DataTableSortState | DataTableSortState[] | null) {
    const state = Array.isArray(sorter) ? sorter[0] : sorter
    sortKey.value = typeof state?.columnKey === 'string' ? state.columnKey : null
    sortOrder.value = state?.order || null
    void loadData()
  }

  async function reload() {
    await loadData()
  }

  return {
    symbols,
    loading,
    pagination,
    handlePageChange,
    handlePageSizeChange,
    handleSorterChange,
    reload,
    applyFilters,
  }
}
