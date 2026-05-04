import type { VNodeChild } from 'vue'

export interface SymbolColumnDef<Row> {
  key: string
  title: string
  width?: number
  fixed?: 'left' | 'right'
  sorter?: boolean
  defaultVisible?: boolean
  locked?: boolean
  render: (row: Row) => VNodeChild
}
