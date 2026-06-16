import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradeCalEntity } from '../../entities/raw/trade-cal.entity';
import { StkLimitEntity } from '../../entities/raw/stk-limit.entity';
import { SuspendEntity } from '../../entities/raw/suspend.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { BaseDataSyncService } from './base-data-sync.service';
import { BaseDataSyncController } from './base-data-sync.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TradeCalEntity, StkLimitEntity, SuspendEntity])],
  controllers: [BaseDataSyncController],
  providers: [BaseDataSyncService, TushareClientService],
  exports: [BaseDataSyncService],
})
export class BaseDataSyncModule {}
