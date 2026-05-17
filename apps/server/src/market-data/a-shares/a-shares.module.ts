import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyIndicatorEntity } from '../../entities/raw/daily-indicator.entity';
import { DailyBasicEntity } from '../../entities/raw/daily-basic.entity';
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { AdjFactorEntity } from '../../entities/raw/adj-factor.entity';
import { IndicatorCalcStateEntity } from '../../entities/raw/indicator-calc-state.entity';
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
    DailyQuoteEntity,
    DailyBasicEntity,
    DailyIndicatorEntity,
    AdjFactorEntity,
    IndicatorCalcStateEntity,
    AShareSyncStateEntity,
    AShareFilterPresetEntity,
  ])],
  controllers: [ASharesController],
  providers: [ASharesService, ASharesSyncService, ASharesIndicatorService, ASharesFilterPresetsService, TushareClientService],
  exports: [ASharesService],
})
export class ASharesModule {}
