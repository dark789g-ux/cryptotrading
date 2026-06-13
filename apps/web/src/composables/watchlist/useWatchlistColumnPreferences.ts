import { computed, ref, unref, type MaybeRef } from 'vue'
import type { ColumnPreferenceItem } from '@/api'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import {
  buildColumnsFromPreference,
  createDefaultScopePreferences,
  normalizeScopePreferences,
} from '@/composables/symbols/useSymbolColumnPreferences'
import { useWatchlistStore } from '@/stores/watchlist'

export function useWatchlistColumnPreferences<Row>(
  defs: MaybeRef<SymbolColumnDef<Row>[]>,
) {
  const store = useWatchlistStore()
  const saving = ref(false)

  const scopePreferences = computed<ColumnPreferenceItem[]>({
    get: () => normalizeScopePreferences(unref(defs), store.columnPreferences),
    set: (next) => {
      store.saveColumnPreferences(normalizeScopePreferences(unref(defs), next))
    },
  })

  const columns = computed(() => buildColumnsFromPreference(unref(defs), scopePreferences.value))

  function reset() {
    scopePreferences.value = createDefaultScopePreferences(unref(defs))
  }

  function save() {
    saving.value = true
    try {
      store.saveColumnPreferences(scopePreferences.value)
    } finally {
      saving.value = false
    }
  }

  return {
    saving,
    scopePreferences,
    columns,
    reset,
    save,
  }
}
