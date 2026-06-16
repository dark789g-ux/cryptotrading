import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsIndexAmvDailyEntity } from '../../entities/raw/us-index-amv-daily.entity';
import { UsIndexConstituentEntity } from '../../entities/raw/us-index-constituent.entity';
import { QuantModule } from '../../modules/quant/quant.module';
import { UsIndexAmvController } from './us-index-amv.controller';
import { UsIndexAmvService } from './us-index-amv.service';

/**
 * 美股指数活跃市值（AMV）只读查询 + 触发模块（spec 2026-06-16-us-index-amv-design 05）。
 *
 * 只读 raw.us_index_amv_daily（getSeries / getDateRange）+ 派 ml.jobs(run_type='us_index_amv_sync')。
 * 不算任何衍生数据（AMV 由 Python worker 算并落库）。
 *
 * 两实体已在 app.module.ts 根 entities[] 注册（双注册，T4），此处 forFeature 供 TypeOrmModule
 * 元数据解析（成分表查询走 Python 侧，NestJS 不读，实体仅为双注册 / 未来 ORM 用）。
 * QuantModule 导出 QuantJobsService，供 sync 派 job 复用既有创建逻辑。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UsIndexAmvDailyEntity, UsIndexConstituentEntity]),
    QuantModule,
  ],
  controllers: [UsIndexAmvController],
  providers: [UsIndexAmvService],
})
export class UsIndexAmvModule {}
