import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { AShareSymbolEntity } from '../entities/a-share/a-share-symbol.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';
import { StrategyConditionsRunner } from './strategy-conditions.runner';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { KdjRecomputeService } from './kdj-recompute.service';
import { RunQueue } from './strategy-conditions.queue';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StrategyConditionEntity,
      StrategyConditionRunEntity,
      StrategyConditionHitEntity,
      AShareSymbolEntity,
    ]),
  ],
  controllers: [StrategyConditionsController],
  providers: [
    StrategyConditionsQueryBuilder,
    StrategyConditionsRunner,
    StrategyConditionsService,
    // KDJ 自定义参数实时重算（T3）：供 runner 注入，同模块 provider 无需 export。
    KdjRecomputeService,
    RunQueue,
  ],
  // QueryBuilder 供 regime-engine 模块复用条件→SQL 翻译（不复制查询构建逻辑）
  exports: [StrategyConditionsService, StrategyConditionsQueryBuilder],
})
export class StrategyConditionsModule {}
