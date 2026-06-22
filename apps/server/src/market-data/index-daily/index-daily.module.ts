import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';
import { IndexDailyService } from './index-daily.service';
import { IndexLatestController, IndexDailyController } from './index-daily.controller';

/**
 * 统一 A 股指数日线模块。
 * spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md
 *
 * GET /api/indices/latest（行情表最新行情）+ GET /api/index-daily（K线，全 category）；
 * 旧路径 /ths-index-daily 薄封装（WHERE category IN industry/concept）由 ThsIndexDailyModule 提供。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IndexDailyQuoteEntity, IndexDailyIndicatorEntity]),
  ],
  controllers: [IndexLatestController, IndexDailyController],
  providers: [IndexDailyService],
})
export class IndexDailyModule {}
