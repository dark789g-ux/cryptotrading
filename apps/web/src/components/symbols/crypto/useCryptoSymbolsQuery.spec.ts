import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { DataTableSortState } from 'naive-ui'

import { useCryptoSymbolsQuery } from './useCryptoSymbolsQuery'
import { symbolApi } from '@/api'
import type { SymbolRow } from '@/api'
import type { NumericCondition } from '@/components/common/numericConditionFilterTypes'

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    symbolApi: {
      ...actual.symbolApi,
      query: vi.fn(),
    },
  }
})

function createRefs() {
  return {
    interval: ref('1h'),
    searchQuery: ref(''),
    watchlistIds: ref<string[] | undefined>(undefined),
    selectedStrategyIds: ref<string[]>([]),
    conditions: ref<NumericCondition[]>([]),
  }
}

function setup(options?: Partial<ReturnType<typeof createRefs>>) {
  const refs = createRefs()
  const message = { error: vi.fn() }
  const query = useCryptoSymbolsQuery({
    message,
    interval: options?.interval ?? refs.interval,
    searchQuery: options?.searchQuery ?? refs.searchQuery,
    watchlistIds: options?.watchlistIds ?? refs.watchlistIds,
    selectedStrategyIds: options?.selectedStrategyIds ?? refs.selectedStrategyIds,
    conditions: options?.conditions ?? refs.conditions,
  })
  return { ...query, message, refs, queryApi: symbolApi.query }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(symbolApi.query).mockReset()
  vi.mocked(symbolApi.query).mockResolvedValue({ items: [], total: 0 })
})

describe('useCryptoSymbolsQuery', () => {
  it('初始状态为空且未加载', () => {
    const { symbols, loading, pagination } = setup()

    expect(symbols.value).toEqual([])
    expect(loading.value).toBe(false)
    expect(pagination.value).toEqual({ page: 1, pageSize: 20, itemCount: 0 })
  })

  it('reload 会请求数据并更新 symbols、total、pagination', async () => {
    const rows: SymbolRow[] = [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }]
    vi.mocked(symbolApi.query).mockResolvedValue({ items: rows, total: 100 })

    const { symbols, loading, pagination, reload } = setup()

    const promise = reload()
    expect(loading.value).toBe(true)

    await promise
    await flushPromises()

    expect(loading.value).toBe(false)
    expect(symbols.value).toEqual(rows)
    expect(pagination.value).toEqual({ page: 1, pageSize: 20, itemCount: 100 })
    expect(symbolApi.query).toHaveBeenCalledTimes(1)
    expect(symbolApi.query).toHaveBeenLastCalledWith({
      interval: '1h',
      q: '',
      conditions: [],
      watchlistIds: undefined,
      strategyHitIds: [],
      sort: { field: 'symbol', asc: true },
      page: 1,
      page_size: 20,
    })
  })

  it('handlePageChange 切换到指定页并请求', async () => {
    const { handlePageChange, pagination } = setup()

    handlePageChange(2)
    expect(pagination.value.page).toBe(2)

    await flushPromises()
    await nextTick()

    expect(symbolApi.query).toHaveBeenCalledTimes(1)
    expect(symbolApi.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    )
  })

  it('handlePageSizeChange 重置到第 1 页并使用新页大小', async () => {
    vi.mocked(symbolApi.query).mockResolvedValue({ items: [], total: 0 })

    const { handlePageSizeChange, pagination } = setup()

    handlePageSizeChange(50)
    await flushPromises()
    await nextTick()

    expect(pagination.value).toEqual({ page: 1, pageSize: 50, itemCount: 0 })
    expect(symbolApi.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, page_size: 50 }),
    )
  })

  it('handleSorterChange 更新排序字段与方向', async () => {
    vi.mocked(symbolApi.query).mockResolvedValue({ items: [], total: 0 })

    const { handleSorterChange } = setup()

    handleSorterChange({ columnKey: 'close', order: 'descend', sorter: 'default' } as DataTableSortState)
    await flushPromises()
    await nextTick()

    expect(symbolApi.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: { field: 'close', asc: false } }),
    )

    handleSorterChange({ columnKey: 'volume', order: 'ascend', sorter: 'default' } as DataTableSortState)
    await flushPromises()
    await nextTick()

    expect(symbolApi.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: { field: 'volume', asc: true } }),
    )
  })

  it('applyFilters 会重置到第 1 页并请求', async () => {
    vi.mocked(symbolApi.query).mockResolvedValue({ items: [], total: 0 })

    const { handlePageChange, applyFilters, pagination } = setup()

    handlePageChange(3)
    await flushPromises()
    expect(pagination.value.page).toBe(3)

    await applyFilters()
    await flushPromises()

    expect(pagination.value.page).toBe(1)
    expect(symbolApi.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1 }),
    )
  })

  it('请求失败时调用 message.error 并关闭 loading', async () => {
    vi.mocked(symbolApi.query).mockRejectedValue(new Error('network error'))

    const { reload, loading, message } = setup()

    const promise = reload()
    expect(loading.value).toBe(true)

    await promise
    await flushPromises()

    expect(loading.value).toBe(false)
    expect(message.error).toHaveBeenCalledWith('network error')
  })

  it('filter 参数变化后 reload 会传入最新值', async () => {
    vi.mocked(symbolApi.query).mockResolvedValue({ items: [], total: 0 })

    const refs = createRefs()
    const { reload } = setup(refs)

    refs.interval.value = '4h'
    refs.searchQuery.value = 'btc'
    refs.watchlistIds.value = ['wl-1']
    refs.selectedStrategyIds.value = ['st-1']
    refs.conditions.value = [{ field: 'KDJ.J', op: 'lt', value: 10 }]

    await reload()
    await flushPromises()

    expect(symbolApi.query).toHaveBeenLastCalledWith({
      interval: '4h',
      q: 'btc',
      conditions: [{ field: 'KDJ.J', op: 'lt', value: 10 }],
      watchlistIds: ['wl-1'],
      strategyHitIds: ['st-1'],
      sort: { field: 'symbol', asc: true },
      page: 1,
      page_size: 20,
    })
  })
})
