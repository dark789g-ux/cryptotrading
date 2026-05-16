import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThsIndexDailyQuoteEntity } from '../../entities/ths-index-daily/ths-index-daily-quote.entity';
import { ThsIndexDailyIndicatorEntity } from '../../entities/ths-index-daily/ths-index-daily-indicator.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsIndexDailyService } from './ths-index-daily.service';
import { ThsIndexDailySyncService } from './ths-index-daily-sync.service';
import { ThsIndexDailyIndicatorService } from './ths-index-daily-indicator.service';
import { ThsIndexDailyController } from './ths-index-daily.controller';
import { ThsIndexDailySyncController } from './ths-index-daily-sync.controller';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ThsIndexDailyQuoteEntity,
      ThsIndexDailyIndicatorEntity,
      ThsIndexCatalogEntity,
    ]),
  ],
  controllers: [ThsIndexDailyController, ThsIndexDailySyncController],
  providers: [
    ThsIndexDailyService,
    ThsIndexDailySyncService,
    ThsIndexDailyIndicatorService,
    TushareClientService,
  ],
})
export class ThsIndexDailyModule {}
