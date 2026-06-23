import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { ThsIndexDailyModule } from '../ths-index-daily/ths-index-daily.module';
import { SwIndexDailySyncService } from './sw-index-daily-sync.service';
import { SwIndexDailySyncController } from './sw-index-daily-sync.controller';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

/**
 * 申万行业指数日线同步模块。
 *
 * 依赖 ThsIndexDailyModule：复用 ThsIndexDailyIndicatorService.recalculateForSymbols
 * （读全 category 不分类，申万 K 线零改动自动有 MA/MACD/KDJ/BBI/BRICK）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      IndexDailyQuoteEntity,
      IndexDailyIndicatorEntity,
      SwIndexCatalogEntity,
    ]),
    ThsIndexDailyModule,
  ],
  controllers: [SwIndexDailySyncController],
  providers: [SwIndexDailySyncService, TushareClientService],
  exports: [SwIndexDailySyncService],
})
export class SwIndexDailyModule {}
