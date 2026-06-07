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
import { SignalStatsController } from './signal-stats/signal-stats.controller';
import { SignalStatsService } from './signal-stats/signal-stats.service';
import { SignalStatsRunner } from './signal-stats/signal-stats.runner';
import { SignalStatsEnumerator } from './signal-stats/signal-stats.enumerator';
import { SignalStatsSimulator } from './signal-stats/signal-stats.simulator.db';

@Module({
  imports: [TypeOrmModule.forFeature([
    StrategyConditionEntity,
    StrategyConditionRunEntity,
    StrategyConditionHitEntity,
    SignalTestEntity,
    SignalTestRunEntity,
    SignalTestTradeEntity,
  ])],
  controllers: [StrategyConditionsController, SignalStatsController],
  providers: [
    StrategyConditionsQueryBuilder,
    StrategyConditionsRunner,
    StrategyConditionsService,
    SignalStatsService,
    SignalStatsRunner,
    SignalStatsEnumerator,
    SignalStatsSimulator,
  ],
  exports: [StrategyConditionsService],
})
export class StrategyConditionsModule {}
