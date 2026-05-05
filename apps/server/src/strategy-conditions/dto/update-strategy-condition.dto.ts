import { StrategyConditionItemDto } from './create-strategy-condition.dto';

export interface UpdateStrategyConditionDto {
  name?: string;
  conditions?: StrategyConditionItemDto[];
}
