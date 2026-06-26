import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { watchlistApi, type Watchlist, type WatchlistQuoteRow } from '@/api'

const ASHARE_SYMBOL_RE = /^\d{6}\.(SZ|SH|BJ)$/

export const useWatchlistStore = defineStore('watchlist', () => {
  // State
  const watchlists = ref<Watchlist[]>([])
  const currentId = ref<string | null>(null)
  const quotes = ref<WatchlistQuoteRow[]>([])
  const total = ref(0)
  const loadingLists = ref(false)
  const loadingQuotes = ref(false)
  const page = ref(1)
  const pageSize = ref(20)
  const sortKey = ref<string | null>(null)
  const sortOrder = ref<'ascend' | 'descend' | null>(null)
  const loaded = ref(false)
  let loadPromise: Promise<void> | null = null

  // Getters
  const currentWatchlist = computed(() =>
    watchlists.value.find((w) => w.id === currentId.value) ?? null,
  )
  const interval = computed<'1h' | '1d'>(() => {
    const items = currentWatchlist.value?.items ?? []
    return items.length > 0 && items.every((item) => ASHARE_SYMBOL_RE.test(item.symbol))
      ? '1d'
      : '1h'
  })

  // Actions
  async function loadWatchlists() {
    if (loadPromise) return loadPromise

    loadingLists.value = true
    loadPromise = (async () => {
      try {
        const hadSelection = !!currentId.value
        watchlists.value = await watchlistApi.list()
        if (!currentId.value && watchlists.value.length > 0) {
          currentId.value = watchlists.value[0].id
        }
        if (!hadSelection && currentId.value) {
          await loadQuotes()
        }
        loaded.value = true
      } finally {
        loadingLists.value = false
        loadPromise = null
      }
    })()

    return loadPromise
  }

  async function ensureWatchlistsLoaded() {
    if (loaded.value) return
    await loadWatchlists()
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
    loadWatchlists,
    setCurrentId,
    loadQuotes,
    reorderWatchlists,
    reorderItems,
    ensureWatchlistsLoaded,
  }
})
