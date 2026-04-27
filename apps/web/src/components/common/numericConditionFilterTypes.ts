import type { SelectMixedOption } from 'naive-ui/es/select/src/interface'

export type NumericConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
export type NumericConditionValueType = 'number' | 'field'

export interface NumericNumberCondition {
  field: string
  op: NumericConditionOp
  valueType?: 'number'
  value: number
}

export interface NumericFieldCondition {
  field: string
  op: NumericConditionOp
  valueType: 'field'
  compareField: string
}

export type NumericCondition = NumericNumberCondition | NumericFieldCondition

export type NumericConditionFieldOption = SelectMixedOption
