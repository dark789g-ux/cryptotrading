import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { watchlistApi, type Watchlist, type SymbolRow } from '@/api'

const STORAGE_KEY = 'watchlist-columns'
const DEFAULT_COLUMNS = ['symbol', 'close', 'ma5', 'ma30', 'kdjJ', 'riskRewardRatio']

export const useWatchlistStore = defineStore('watchlist', () => {
  // State
  const watchlists = ref<Watchlist[]>([])
  const currentId = ref<string | null>(null)
  const quotes = ref<SymbolRow[]>([])
  const total = ref(0)
  const loadingLists = ref(false)
  const loadingQuotes = ref(false)
  const interval = ref<'1h' | '4h' | '1d'>('1h')
  const page = ref(1)
  const pageSize = ref(20)
  const sortKey = ref<string | null>(null)
  const sortOrder = ref<'ascend' | 'descend' | null>(null)
  const columns = ref<string[]>(loadColumns())

  // Getters
  const currentWatchlist = computed(() =>
    watchlists.value.find((w) => w.id === currentId.value) ?? null,
  )

  // Actions
  async function loadWatchlists() {
    loadingLists.value = true
    try {
      watchlists.value = await watchlistApi.list()
      if (!currentId.value && watchlists.value.length > 0) {
        currentId.value = watchlists.value[0].id
      }
    } finally {
      loadingLists.value = false
    }
  }

  function setCurrentId(id: string | null) {
    currentId.value = id
    page.value = 1
    sortKey.value = null
    sortOrder.value = null
    if (id) {
      loadQuotes()
    } else {
      quotes.value = []
      total.value = 0
    }
  }

  async function loadQuotes() {
    if (!currentId.value) return
    loadingQuotes.value = true
    try {
      const res = await watchlistApi.quotes(currentId.value, {
        interval: interval.value,
        page: page.value,
        pageSize: pageSize.value,
        sort: sortKey.value ? { field: sortKey.value, order: sortOrder.value } : undefined,
      })
      quotes.value = res.items
      total.value = res.total
    } finally {
      loadingQuotes.value = false
    }
  }

  async function reorderWatchlists(ids: string[]) {
    const old = [...watchlists.value]
    watchlists.value = ids.map((id) => old.find((w) => w.id === id)!).filter(Boolean)
    try {
      await watchlistApi.reorder(ids)
    } catch {
      watchlists.value = old
      throw new Error('列表排序失败')
    }
  }

  async function reorderItems(symbols: string[]) {
    if (!currentId.value) return
    const old = [...quotes.value]
    quotes.value = symbols.map((s) => old.find((q) => q.symbol === s)!).filter(Boolean)
    try {
      await watchlistApi.reorderItems(currentId.value, symbols)
    } catch {
      quotes.value = old
      throw new Error('标的排序失败')
    }
  }

  function saveColumns(cols: string[]) {
    columns.value = cols
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cols))
  }

  function loadColumns(): string[] {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : DEFAULT_COLUMNS
    } catch {
      return DEFAULT_COLUMNS
    }
  }

  return {
    watchlists,
    currentId,
    currentWatchlist,
    quotes,
    total,
    loadingLists,
    loadingQuotes,
    interval,
    page,
    pageSize,
    sortKey,
    sortOrder,
    columns,
    loadWatchlists,
    setCurrentId,
    loadQuotes,
    reorderWatchlists,
    reorderItems,
    saveColumns,
  }
})
