import type { AShareFilterPresetFilters, AShareRow } from '@/api'
import type { NumericCondition } from '../../common/numericConditionFilterTypes'

export interface SelectOption {
  label: string
  value: string
  [key: string]: unknown
}

export type Condition = NumericCondition

export type ASharesFilterState = AShareFilterPresetFilters

export interface SummaryItem {
  label: string
  value: string
  note: string
  className: string
}

export type ASharesSortKey = keyof AShareRow | string
