import type { AShareFilterPresetFilters, AShareRow } from '../../../composables/useApi'

export interface SelectOption {
  label: string
  value: string
  [key: string]: unknown
}

export interface Condition {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: number
}

export type ASharesFilterState = AShareFilterPresetFilters

export interface SummaryItem {
  label: string
  value: string
  note: string
  className: string
}

export type ASharesSortKey = keyof AShareRow | string
