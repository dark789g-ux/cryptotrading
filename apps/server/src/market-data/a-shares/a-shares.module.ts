import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AShareDailyIndicatorEntity } from '../../entities/a-share/a-share-daily-indicator.entity';
import { AShareDailyMetricEntity } from '../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { AShareAdjFactorEntity } from '../../entities/a-share/a-share-adj-factor.entity';
import { ASharesController } from './a-shares.controller';
import { ASharesIndicatorService } from './a-shares-indicator.service';
import { ASharesService } from './a-shares.service';
import { ASharesSyncService } from './a-shares-sync.service';
import { TushareClientService } from './tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    AShareSymbolEntity,
    AShareDailyQuoteEntity,
    AShareDailyMetricEntity,
    AShareDailyIndicatorEntity,
    AShareAdjFactorEntity,
  ])],
  controllers: [ASharesController],
  providers: [ASharesService, ASharesSyncService, ASharesIndicatorService, TushareClientService],
  exports: [ASharesService],
})
export class ASharesModule {}
