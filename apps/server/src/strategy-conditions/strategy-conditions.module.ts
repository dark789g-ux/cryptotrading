import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { SignalTestEntity } from '../entities/strategy/signal-test.entity';
import { SignalTestRunEntity } from '../entities/strategy/signal-test-run.entity';
import { SignalTestTradeEntity } from '../entities/strategy/signal-test-trade.entity';
import { SignalTestEquityEntity } from '../entities/strategy/signal-test-equity.entity';
import { AShareSymbolEntity } from '../entities/a-share/a-share-symbol.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';
import { StrategyConditionsRunner } from './strategy-conditions.runner';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { KdjRecomputeService } from './kdj-recompute.service';
import { SignalStatsController } from './signal-stats/signal-stats.controller';
import { SignalStatsService } from './signal-stats/signal-stats.service';
import { SignalStatsRunner } from './signal-stats/signal-stats.runner';
import { SignalStatsEnumerator } from './signal-stats/signal-stats.enumerator';
import { SignalStatsSimulator } from './signal-stats/signal-stats.simulator.db';
import { PortfolioSimModule } from './portfolio-sim/portfolio-sim.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StrategyConditionEntity,
      StrategyConditionRunEntity,
      StrategyConditionHitEntity,
      SignalTestEntity,
      SignalTestRunEntity,
      SignalTestTradeEntity,
      SignalTestEquityEntity,
      AShareSymbolEntity,
    ]),
    // 迷你回测层（M1）注入 PortfolioSimLoader（spec 04 §4.1）。
    PortfolioSimModule,
  ],
  controllers: [StrategyConditionsController, SignalStatsController],
  providers: [
    StrategyConditionsQueryBuilder,
    StrategyConditionsRunner,
    StrategyConditionsService,
    // KDJ 自定义参数实时重算（T3）：供 runner 注入，同模块 provider 无需 export。
    KdjRecomputeService,
    SignalStatsService,
    SignalStatsRunner,
    SignalStatsEnumerator,
    SignalStatsSimulator,
  ],
  // QueryBuilder 供 regime-engine 模块复用条件→SQL 翻译（不复制查询构建逻辑）
  exports: [StrategyConditionsService, StrategyConditionsQueryBuilder],
})
export class StrategyConditionsModule {}
