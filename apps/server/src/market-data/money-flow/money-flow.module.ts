import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { MoneyFlowThsIndustryEntity } from '../../entities/money-flow/money-flow-ths-industry.entity';
import { MoneyFlowIndexEntity } from '../../entities/money-flow/money-flow-index.entity';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';
import { MoneyFlowController } from './money-flow.controller';
import { MoneyFlowSyncController } from './money-flow-sync.controller';
import { MoneyFlowService } from './money-flow.service';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { MoneyFlowAggregationService } from './money-flow-aggregation.service';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    AShareSymbolEntity,
    MoneyFlowStockEntity,
    MoneyFlowIndustryEntity,
    MoneyFlowSectorEntity,
    MoneyFlowMarketEntity,
    ThsMemberStockEntity,
    MoneyFlowIndexEntity,
    MoneyFlowThsIndustryEntity,
    IndexWeightEntity,
  ])],
  controllers: [MoneyFlowController, MoneyFlowSyncController],
  providers: [MoneyFlowService, MoneyFlowSyncService, MoneyFlowAggregationService, TushareClientService],
  exports: [MoneyFlowSyncService],
})
export class MoneyFlowModule {}
