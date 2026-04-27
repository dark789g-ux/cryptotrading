import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AShareDailyIndicatorEntity } from '../../entities/a-share/a-share-daily-indicator.entity';
import { AShareDailyMetricEntity } from '../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { AShareAdjFactorEntity } from '../../entities/a-share/a-share-adj-factor.entity';
import { AShareIndicatorCalcStateEntity } from '../../entities/a-share/a-share-indicator-calc-state.entity';
import { AShareSyncStateEntity } from '../../entities/a-share/a-share-sync-state.entity';
import { AShareFilterPresetEntity } from '../../entities/a-share/a-share-filter-preset.entity';
import { ASharesController } from './a-shares.controller';
import { ASharesFilterPresetsService } from './services/a-shares-filter-presets.service';
import { ASharesIndicatorService } from './services/a-shares-indicator.service';
import { ASharesService } from './a-shares.service';
import { ASharesSyncService } from './sync/a-shares-sync.service';
import { TushareClientService } from './services/tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    AShareSymbolEntity,
    AShareDailyQuoteEntity,
    AShareDailyMetricEntity,
    AShareDailyIndicatorEntity,
    AShareAdjFactorEntity,
    AShareIndicatorCalcStateEntity,
    AShareSyncStateEntity,
    AShareFilterPresetEntity,
  ])],
  controllers: [ASharesController],
  providers: [ASharesService, ASharesSyncService, ASharesIndicatorService, ASharesFilterPresetsService, TushareClientService],
  exports: [ASharesService],
})
export class ASharesModule {}
