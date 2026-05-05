import { computed, ref } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'

export function useWatchlistTagFilter() {
  const watchlistStore = useWatchlistStore()
  const selectedWatchlistIds = ref<string[]>([])

  const watchlistOptions = computed(() =>
    watchlistStore.watchlists.map((w) => ({ label: w.name, value: w.id })),
  )

  const watchlistIds = computed(() =>
    selectedWatchlistIds.value.length > 0 ? selectedWatchlistIds.value : undefined,
  )

  function resetWatchlistFilter() {
    selectedWatchlistIds.value = []
  }

  return {
    selectedWatchlistIds,
    watchlistOptions,
    watchlistIds,
    resetWatchlistFilter,
    ensureWatchlistsLoaded: watchlistStore.ensureWatchlistsLoaded,
  }
}
