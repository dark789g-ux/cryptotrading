import type { VNodeChild } from 'vue'

export interface SymbolColumnDef<Row> {
  key: string
  title: string
  width?: number
  fixed?: 'left' | 'right'
  sorter?: boolean
  defaultVisible?: boolean
  locked?: boolean
  /**
   * 字段说明 conceptId（见 components/common/fieldDescriptions.ts）。
   * 有对应说明时，表头与列设置抽屉会在列名旁渲染 "?" 帮助图标。title 仍保持纯字符串。
   */
  descKey?: string
  render: (row: Row) => VNodeChild
}
