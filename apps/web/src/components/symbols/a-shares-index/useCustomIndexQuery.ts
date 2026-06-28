import { computed, ref } from 'vue'
import type { DataTableSortState } from 'naive-ui'
import {
  customIndexApi,
  type CustomIndexLatestRow,
  type CustomIndexLatestSortField,
} from '@/api/modules/market/customIndex'

export function useCustomIndexQuery(message: {
  error: (content: string) => void
}) {
  const loading = ref(false)
  const rows = ref<CustomIndexLatestRow[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const searchQuery = ref('')
  const sortKey = ref<CustomIndexLatestSortField | null>(null)
  const sortOrder = ref<'ascend' | 'descend' | null>(null)

  const paginationState = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
    showSizePicker: true,
    pageSizes: [20, 50, 100],
    prefix: () => `Total ${total.value}`,
  }))

  async function loadData() {
    loading.value = true
    try {
      const res = await customIndexApi.getLatestList({
        page: page.value,
        pageSize: pageSize.value,
        q: searchQuery.value.trim() || undefined,
        sort: sortKey.value ?? undefined,
        order:
          sortOrder.value == null
            ? undefined
            : sortOrder.value === 'ascend'
              ? 'asc'
              : 'desc',
      })
      rows.value = res.rows
      total.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      loading.value = false
    }
  }

  function applySearch() {
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
    sortKey.value =
      typeof state?.columnKey === 'string'
        ? (state.columnKey as CustomIndexLatestSortField)
        : null
    sortOrder.value = state?.order || null
    void loadData()
  }

  function patchRow(id: string, patch: Partial<CustomIndexLatestRow>) {
    const idx = rows.value.findIndex((r) => r.id === id)
    if (idx >= 0) {
      rows.value[idx] = { ...rows.value[idx], ...patch }
    }
  }

  return {
    loading,
    rows,
    total,
    page,
    pageSize,
    searchQuery,
    paginationState,
    reload: loadData,
    applySearch,
    handlePageChange,
    handlePageSizeChange,
    handleSort,
    patchRow,
  }
}
