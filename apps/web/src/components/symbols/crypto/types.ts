import type { NumericCondition } from '../../common/numericConditionFilterTypes'

export interface SelectOption {
  label: string
  value: string
  [key: string]: unknown
}

export type Condition = NumericCondition
