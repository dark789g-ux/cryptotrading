import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { MoneyFlowThsIndustryEntity } from '../../entities/money-flow/money-flow-ths-industry.entity';
import { MoneyFlowIndexEntity } from '../../entities/money-flow/money-flow-index.entity';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';
import { MoneyFlowController } from './money-flow.controller';
import { MoneyFlowSyncController } from './money-flow-sync.controller';
import { MoneyFlowService } from './money-flow.service';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { MoneyFlowAggregationService } from './money-flow-aggregation.service';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { IndexCatalogModule } from '../index-catalog/index-catalog.module';

@Module({
  imports: [IndexCatalogModule, TypeOrmModule.forFeature([
    AShareSymbolEntity,
    DailyQuoteEntity,
    MoneyFlowStockEntity,
    MoneyFlowIndustryEntity,
    MoneyFlowSectorEntity,
    MoneyFlowMarketEntity,
    ThsMemberStockEntity,
    MoneyFlowIndexEntity,
    MoneyFlowThsIndustryEntity,
    IndexWeightEntity,
    SwIndexCatalogEntity,
  ])],
  controllers: [MoneyFlowController, MoneyFlowSyncController],
  providers: [MoneyFlowService, MoneyFlowSyncService, MoneyFlowAggregationService, TushareClientService],
  exports: [MoneyFlowSyncService],
})
export class MoneyFlowModule {}
