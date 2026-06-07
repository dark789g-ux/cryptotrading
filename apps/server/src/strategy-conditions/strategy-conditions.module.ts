import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { SignalTestEntity } from '../entities/strategy/signal-test.entity';
import { SignalTestRunEntity } from '../entities/strategy/signal-test-run.entity';
import { SignalTestTradeEntity } from '../entities/strategy/signal-test-trade.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';
import { StrategyConditionsRunner } from './strategy-conditions.runner';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';

@Module({
  imports: [TypeOrmModule.forFeature([
    StrategyConditionEntity,
    StrategyConditionRunEntity,
    StrategyConditionHitEntity,
    SignalTestEntity,
    SignalTestRunEntity,
    SignalTestTradeEntity,
  ])],
  controllers: [StrategyConditionsController],
  providers: [StrategyConditionsQueryBuilder, StrategyConditionsRunner, StrategyConditionsService],
  exports: [StrategyConditionsService],
})
export class StrategyConditionsModule {}
