import { type MaybeRef } from 'vue'
import type { SymbolColumnDef } from '@/components/symbols/columns/columnTypes'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'

export function useWatchlistColumnPreferences<Row>(
  defs: MaybeRef<SymbolColumnDef<Row>[]>,
) {
  const {
    saving,
    scopePreferences,
    tableColumns,
    reset,
    save,
    load,
  } = useTableColumnPreferences('watchlist', defs, 'table')

  return {
    saving,
    scopePreferences,
    // 保持现有调用面：columns 即通用底座的 tableColumns（表格视图列）
    columns: tableColumns,
    reset,
    save,
    load,
  }
}
