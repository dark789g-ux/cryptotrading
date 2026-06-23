import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { IndexDailyService } from './index-daily.service';
import { IndexLatestController, IndexDailyController } from './index-daily.controller';

/**
 * 统一 A 股指数日线模块。
 * spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md
 *
 * GET /api/indices/latest（行情表最新行情）+ GET /api/index-daily（K线，全 category）；
 * 旧路径 /ths-index-daily 薄封装（WHERE category IN industry/concept）由 ThsIndexDailyModule 提供。
 *
 * SwIndexCatalogEntity：getLatest 的 type='sw' 分支按 level 过滤 + 取 name（spec 02 §2.8）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      IndexDailyQuoteEntity,
      IndexDailyIndicatorEntity,
      SwIndexCatalogEntity,
    ]),
  ],
  controllers: [IndexLatestController, IndexDailyController],
  providers: [IndexDailyService],
})
export class IndexDailyModule {}
