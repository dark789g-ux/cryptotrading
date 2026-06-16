import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsIndexDailyQuoteEntity } from '../../entities/raw/us-index-daily-quote.entity';
import { UsIndexDailyIndicatorEntity } from '../../entities/raw/us-index-daily-indicator.entity';
import { QuantModule } from '../../modules/quant/quant.module';
import { UsIndexDailyController } from './us-index-daily.controller';
import { UsIndexDailyService } from './us-index-daily.service';

/**
 * 美股指数日线只读查询 + 触发模块（spec 2026-06-16-us-index-subtab-design 02）。
 *
 * 只读 raw.us_index_*（getKlines / getDateRange）+ 派 ml.jobs(run_type='us_index_sync')。
 * 不算任何衍生数据。
 *
 * 两实体已在 app.module.ts 根 entities[] 注册（双注册，Task A），此处 forFeature 供
 * TypeOrmModule 元数据解析。QuantModule 导出 QuantJobsService，供 sync 派 job 复用既有创建逻辑。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UsIndexDailyQuoteEntity, UsIndexDailyIndicatorEntity]),
    QuantModule,
  ],
  controllers: [UsIndexDailyController],
  providers: [UsIndexDailyService],
})
export class UsIndexDailyModule {}
