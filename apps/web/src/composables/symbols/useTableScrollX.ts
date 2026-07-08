import { computed, unref, type ComputedRef, type MaybeRef } from 'vue'
import type { DataTableColumns } from 'naive-ui'

/**
 * 根据当前可见列宽度之和，计算 n-data-table 的 scroll-x 值。
 *
 * Naive UI 在使用 fixed 列时，必须显式设置 scroll-x，否则表头与表体的
 * 横向滚动（shift+滚轮）不同步，导致文字错位。
 */
export function useTableScrollX<Row>(
  columns: MaybeRef<DataTableColumns<Row>>,
): ComputedRef<number> {
  return computed(() => {
    const cols = unref(columns) as Array<{ width?: number }>
    return cols.reduce(
      (sum, col) => sum + (typeof col.width === 'number' ? col.width : 0),
      0,
    )
  })
}
