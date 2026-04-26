import type { AShareRow } from '../../../composables/useApi'

export interface SelectOption {
  label: string
  value: string
  [key: string]: unknown
}

export interface Condition {
  field: 'pctChg' | 'turnoverRate'
  op: 'gte'
  value: number
}

export interface SummaryItem {
  label: string
  value: string
  note: string
  className: string
}

export type ASharesSortKey = keyof AShareRow | string
