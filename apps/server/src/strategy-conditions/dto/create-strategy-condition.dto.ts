import { IsString, IsArray, IsIn, ValidateNested, IsOptional, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

class StrategyConditionItemDto {
  @IsString()
  field: string;

  @IsIn(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'cross_above', 'cross_below'])
  operator: string;

  @IsOptional()
  @IsNumber()
  value?: number;

  @IsOptional()
  @IsString()
  compareField?: string;
}

export class CreateStrategyConditionDto {
  @IsString()
  name: string;

  @IsIn(['crypto', 'a-share'])
  targetType: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyConditionItemDto)
  conditions: StrategyConditionItemDto[];
}
