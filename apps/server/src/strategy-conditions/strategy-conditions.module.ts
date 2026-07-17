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
import { DerivedFieldRegistry } from './derived-field-registry';
import { DerivedFieldRecomputeService } from './derived-field-recompute.service';
import { MaFieldRecomputer } from './derived-field-ma.recomputer';
import { KdjFieldRecomputer } from './derived-field-kdj.recomputer';

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
    // 现算字段基础设施（D1）：供 registry 内的 recomputer 使用
    DerivedFieldRecomputeService,
    MaFieldRecomputer,
    KdjFieldRecomputer,
    RunQueue,
    {
      provide: DerivedFieldRegistry,
      useFactory: (ma: MaFieldRecomputer, kdj: KdjFieldRecomputer) => {
        const r = new DerivedFieldRegistry();
        r.register(ma);
        r.register(kdj);
        return r;
      },
      inject: [MaFieldRecomputer, KdjFieldRecomputer],
    },
  ],
  // QueryBuilder 供 regime-engine 模块复用条件→SQL 翻译（不复制查询构建逻辑）
  // KdjRecomputeService 供 regime-engine 的 DerivedFieldRegistry(KDJ adapter)注入
  exports: [StrategyConditionsService, StrategyConditionsQueryBuilder, KdjRecomputeService],
})
export class StrategyConditionsModule {}
