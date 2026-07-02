import { computed, ref } from 'vue'
import type { DataTableSortState } from 'naive-ui'
import { etfApi } from '@/api/modules/market/etf'
import type { EtfLatestSortField } from './etf.types'

/**
 * ETF 列表查询 composable。
 *
 * 仿 useASharesIndexQuery 的远程分页/排序骨架。
 * ETF 独特筛选：基金类型、管理人、是否公布 IOPV。
 */
export function useEtfQuery(message: {
  error: (content: string) => void
}) {
  const loading = ref(false)
  const rows = ref<import('./etf.types').EtfLatestRow[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const searchQuery = ref('')
  const fundType = ref<string | undefined>(undefined)
  const manager = ref<string | undefined>(undefined)
  const publishIopv = ref<string | undefined>(undefined)
  const sortKey = ref<EtfLatestSortField | null>(null)
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
      const res = await etfApi.getLatestList({
        page: page.value,
        pageSize: pageSize.value,
        q: searchQuery.value.trim() || undefined,
        fundType: fundType.value,
        manager: manager.value,
        publishIopv: publishIopv.value,
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

  /** 基金类型切换 → 回到第一页重查。 */
  function applyFundTypeFilter() {
    page.value = 1
    void loadData()
  }

  /** 管理人切换 → 回到第一页重查。 */
  function applyManagerFilter() {
    page.value = 1
    void loadData()
  }

  /** IOPV 筛选切换 → 回到第一页重查。 */
  function applyIopvFilter() {
    page.value = 1
    void loadData()
  }

  /** 搜索（回车 / 点搜索按钮）→ 回到第一页重查。 */
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
        ? (state.columnKey as EtfLatestSortField)
        : null
    sortOrder.value = state?.order || null
    void loadData()
  }

  return {
    loading,
    rows,
    total,
    page,
    pageSize,
    searchQuery,
    fundType,
    manager,
    publishIopv,
    paginationState,
    reload: loadData,
    applyFundTypeFilter,
    applyManagerFilter,
    applyIopvFilter,
    applySearch,
    handlePageChange,
    handlePageSizeChange,
    handleSort,
  }
}
