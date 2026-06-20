export interface StrategyConditionItemDto {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
  compareMode?: 'field' | 'value';
  /** 自定义 KDJ 参数（N/M1/M2）；仅当 field/compareField 为 KDJ 字段时有意义；缺省视为 9/3/3。 */
  kdjParams?: { n: number; m1: number; m2: number };
  /** 自定义 ROC 周期 N；仅当 field='roc' 时有意义；缺省视为 10。 */
  rocParams?: { n: number };
}

export interface CreateStrategyConditionDto {
  name: string;
  targetType: 'crypto' | 'a-share';
  conditions: StrategyConditionItemDto[];
}
