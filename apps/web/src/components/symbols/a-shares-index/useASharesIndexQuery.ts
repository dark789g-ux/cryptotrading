import { computed, ref } from 'vue'
import type { DataTableSortState } from 'naive-ui'
import { indexDailyApi } from '@/api/modules/market/indexDaily'
import type { IndexCategory, IndexLatestRow, IndexLatestSortField } from './types'

/** 类型筛选值：'all' 合并四类，否则按单一 category。 */
export type IndexTypeFilter = IndexCategory | 'all'

/** 申万层级（仅 type='sw' 生效）。 */
export type SwLevel = 1 | 2 | 3

/**
 * A 股指数行情表查询 composable。
 *
 * 仿 useASharesQuery 的远程分页/排序骨架，但去掉股票面板特有的
 * 评分回填 / 筛选方案 / watchlist（指数行情表不需要）。
 * 排序 order 映射：naive-ui 表头给出 'ascend'/'descend' → 后端 'asc'/'desc'。
 *
 * level 仅申万区使用（selectedType='sw' 时随请求下发；同花顺区不用，始终 undefined）。
 */
export function useASharesIndexQuery(message: {
  error: (content: string) => void
}) {
  const loading = ref(false)
  const rows = ref<IndexLatestRow[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const searchQuery = ref('')
  const selectedType = ref<IndexTypeFilter>('all')
  const swLevel = ref<SwLevel | null>(null)
  const sortKey = ref<IndexLatestSortField | null>(null)
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
      const res = await indexDailyApi.getLatestList({
        page: page.value,
        pageSize: pageSize.value,
        q: searchQuery.value.trim() || undefined,
        type: selectedType.value === 'all' ? undefined : selectedType.value,
        // 仅申万区带 level；同花顺区 selectedType 非 sw，level 即使有值后端也忽略
        level: selectedType.value === 'sw' ? swLevel.value ?? undefined : undefined,
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

  /** 类型下拉切换 → 回到第一页重查。 */
  function applyTypeFilter() {
    page.value = 1
    void loadData()
  }

  /** 申万层级切换 → 回到第一页重查。 */
  function applyLevelFilter() {
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
        ? (state.columnKey as IndexLatestSortField)
        : null
    // state.order 是 SortOrder（'ascend' | 'descend' | false）；false → null（与 useASharesQuery 一致）
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
    selectedType,
    swLevel,
    paginationState,
    reload: loadData,
    applyTypeFilter,
    applyLevelFilter,
    applySearch,
    handlePageChange,
    handlePageSizeChange,
    handleSort,
  }
}
