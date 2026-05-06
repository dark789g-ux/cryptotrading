import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy-condition-hit.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';
import { StrategyConditionsRunner } from './strategy-conditions.runner';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';

@Module({
  imports: [TypeOrmModule.forFeature([
    StrategyConditionEntity,
    StrategyConditionRunEntity,
    StrategyConditionHitEntity,
  ])],
  controllers: [StrategyConditionsController],
  providers: [StrategyConditionsQueryBuilder, StrategyConditionsRunner, StrategyConditionsService],
  exports: [StrategyConditionsService],
})
export class StrategyConditionsModule {}
