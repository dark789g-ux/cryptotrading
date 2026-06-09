import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KellySweepResult } from '../../../entities/ml/kelly-sweep-result.entity';
import { MlJobEntity } from '../../../entities/ml/ml-job.entity';
import { KellySweepController } from './kelly-sweep.controller';
import { KellySweepService } from './kelly-sweep.service';

/**
 * 凯利网格搜索结果查询模块（只读）。
 *
 * 路由挂载在 `quant/kelly-sweep`，受全局 AuthGuard 保护。
 *
 * ⚠ 双注册约定：KellySweepResult 在此处 forFeature 声明，
 *   同时须在 app.module.ts 根 entities 数组中注册（已完成）。
 *   漏 app.module 注册 → 编译绿、运行时 EntityMetadataNotFound 500。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([KellySweepResult, MlJobEntity]),
  ],
  controllers: [KellySweepController],
  providers: [KellySweepService],
  exports: [KellySweepService],
})
export class KellySweepModule {}
