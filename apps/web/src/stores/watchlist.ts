import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { watchlistApi, type Watchlist, type WatchlistQuoteRow, type ColumnPreferenceItem } from '@/api'
import { createDefaultScopePreferences, normalizeScopePreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import { createWatchlistColumnDefs } from '@/components/watchlist/watchlistColumnDefs'

const STORAGE_KEY = 'watchlist-columns'
const ASHARE_SYMBOL_RE = /^\d{6}\.(SZ|SH|BJ)$/

function buildDefaultColumnPreferences(): ColumnPreferenceItem[] {
  const defs = createWatchlistColumnDefs({
    scoresMap: ref(new Map()),
    scoresLoading: ref(false),
    hitLookup: ref(new Map()),
    onViewChart: () => {},
    onRemove: () => {},
  })
  return createDefaultScopePreferences(defs)
}

function migrateLegacyColumns(raw: unknown): ColumnPreferenceItem[] {
  const defaults = buildDefaultColumnPreferences()
  if (!Array.isArray(raw)) return defaults

  if (raw.length > 0 && typeof raw[0] === 'string') {
    const legacyKeys = raw as string[]
    const defaultVisible = new Set(legacyKeys)
    return defaults.map((item) => ({
      key: item.key,
      visible: item.visible || defaultVisible.has(item.key),
    }))
  }

  if (raw.every((item) => item && typeof item === 'object' && typeof (item as ColumnPreferenceItem).key === 'string')) {
    const defs = createWatchlistColumnDefs({
      scoresMap: ref(new Map()),
      scoresLoading: ref(false),
      hitLookup: ref(new Map()),
      onViewChart: () => {},
      onRemove: () => {},
    })
    return normalizeScopePreferences(defs, raw)
  }

  return defaults
}

function loadColumnPreferences(): ColumnPreferenceItem[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return buildDefaultColumnPreferences()
    return migrateLegacyColumns(JSON.parse(saved))
  } catch {
    return buildDefaultColumnPreferences()
  }
}

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
  const columnPreferences = ref<ColumnPreferenceItem[]>(loadColumnPreferences())
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

  function saveColumnPreferences(prefs: ColumnPreferenceItem[]) {
    columnPreferences.value = prefs
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
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
    columnPreferences,
    loadWatchlists,
    setCurrentId,
    loadQuotes,
    reorderWatchlists,
    reorderItems,
    saveColumnPreferences,
    ensureWatchlistsLoaded,
  }
})
