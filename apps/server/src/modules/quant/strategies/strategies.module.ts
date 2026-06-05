import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyDefinitionEntity } from '../../../entities/ml/strategy-definition.entity';
import { StrategiesController } from './strategies.controller';
import { QuantStrategiesService } from './strategies.service';

/**
 * `apps/server/src/modules/quant/strategies/`：出场策略定义 CRUD。
 *
 * 端点详见 `strategies.controller.ts` 头注。表 `factors.strategy_definitions` 由
 * Alembic（quant-pipeline 侧）建表，NestJS `synchronize: false`；本 module 仅做读写。
 *
 * `QuantStrategiesService` 导出供 `LabelsModule` 在建 strategy_aware 标签时校验
 * 引用的策略存在且 enabled（spec 04 §6.2）。
 *
 * ⚠ 实体双注册：此处 forFeature 之外，`app.module.ts` 根 entities 数组也须加
 *   StrategyDefinitionEntity，漏则运行时 EntityMetadataNotFound 500。
 */
@Module({
  imports: [TypeOrmModule.forFeature([StrategyDefinitionEntity])],
  controllers: [StrategiesController],
  providers: [QuantStrategiesService],
  exports: [QuantStrategiesService],
})
export class QuantStrategiesModule {}
