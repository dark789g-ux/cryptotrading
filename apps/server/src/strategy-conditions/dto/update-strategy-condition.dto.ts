import { PartialType } from '@nestjs/mapped-types';
import { CreateStrategyConditionDto } from './create-strategy-condition.dto';

export class UpdateStrategyConditionDto extends PartialType(CreateStrategyConditionDto) {}
