import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { DataTableColumns } from 'naive-ui'

import { useTableScrollX } from './useTableScrollX'

interface Row { a: number }

// 仅取求和需要的字段；DataTableColumns 含 selection 等非数据列，这里聚焦 width。
type Col = { key: string; width?: number }

describe('useTableScrollX', () => {
  it('正常求和（多列各有 width）', () => {
    const cols: DataTableColumns<Row> = [
      { key: 'a', width: 120 } as Col,
      { key: 'b', width: 80 } as Col,
      { key: 'c', width: 200 } as Col,
    ] as unknown as DataTableColumns<Row>
    const scrollX = useTableScrollX(cols)
    expect(scrollX.value).toBe(400)
  })

  it('某列缺 width 时当 0 处理', () => {
    const cols: DataTableColumns<Row> = [
      { key: 'a', width: 100 } as Col,
      { key: 'b' } as Col, // 缺 width
      { key: 'c', width: 200 } as Col,
    ] as unknown as DataTableColumns<Row>
    const scrollX = useTableScrollX(cols)
    expect(scrollX.value).toBe(300)
  })

  it('空数组返回 0', () => {
    const cols: DataTableColumns<Row> = []
    const scrollX = useTableScrollX(cols)
    expect(scrollX.value).toBe(0)
  })

  it('响应式：列变化时计算值更新', () => {
    const colsRef = ref<DataTableColumns<Row>>([
      { key: 'a', width: 100 } as Col,
      { key: 'b', width: 200 } as Col,
    ] as unknown as DataTableColumns<Row>)
    const scrollX = useTableScrollX(colsRef)
    expect(scrollX.value).toBe(300)

    // 新增一列 → 求和更新
    colsRef.value = [
      { key: 'a', width: 100 } as Col,
      { key: 'b', width: 200 } as Col,
      { key: 'c', width: 300 } as Col,
    ] as unknown as DataTableColumns<Row>
    expect(scrollX.value).toBe(600)
  })
})
