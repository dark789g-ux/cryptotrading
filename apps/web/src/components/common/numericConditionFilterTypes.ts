import type { SelectMixedOption } from 'naive-ui/es/select/src/interface'

export interface NumericCondition {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: number
}

export type NumericConditionFieldOption = SelectMixedOption
