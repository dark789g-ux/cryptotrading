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

/**
 * 字段选项。在 naive 原生 SelectMixedOption 基础上允许可选 descKey
 * （字段说明 conceptId，见 components/common/fieldDescriptions.ts），
 * 用于 NumericConditionFilter 下拉的 "?" 帮助图标；不带 descKey 时行为不变。
 */
export type NumericConditionFieldOption = SelectMixedOption & { descKey?: string }
