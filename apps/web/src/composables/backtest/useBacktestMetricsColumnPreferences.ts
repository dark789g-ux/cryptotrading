import { type MaybeRef } from 'vue'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'

/**
 * 回测「逐 K 标的指标」表的列偏好 composable。
 *
 * 转调通用 useTableColumnPreferences('backtestMetrics', ...)，持久化走后端。
 */
export function useBacktestMetricsColumnPreferences<Row>(defs: MaybeRef<SymbolColumnDef<Row>[]>) {
  const {
    saving,
    scopePreferences,
    tableColumns,
    reset,
    save,
    load,
  } = useTableColumnPreferences('backtestMetrics', defs, 'table')

  return {
    saving,
    scopePreferences,
    tableColumns,
    reset,
    save,
    load,
  }
}
