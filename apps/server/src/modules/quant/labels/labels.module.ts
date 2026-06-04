import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LabelDefinitionEntity } from '../../../entities/ml/label-definition.entity';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';

/**
 * `apps/server/src/modules/quant/labels/`：标签定义 CRUD + 展开 API。
 *
 * 端点详见 `labels.controller.ts` 头注。表 `factors.label_definitions` 由
 * Alembic（quant-pipeline 侧）建表，NestJS `synchronize: false`；本 module 仅做读写。
 *
 * `LabelsService` 导出供 `QuantJobsService` 调用 `expandForTraining()`。
 */
@Module({
  imports: [TypeOrmModule.forFeature([LabelDefinitionEntity])],
  controllers: [LabelsController],
  providers: [LabelsService],
  exports: [LabelsService],
})
export class LabelsModule {}
