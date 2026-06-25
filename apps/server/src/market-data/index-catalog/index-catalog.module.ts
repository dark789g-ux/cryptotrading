import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { IndexCatalogSyncController } from './index-catalog-sync.controller';
import { IndexCatalogSyncService } from './index-catalog-sync.service';
import { IndexCatalogController } from './index-catalog.controller';
import { IndexCatalogQueryService } from './index-catalog-query.service';
import { MarketIndexScopeController } from './market-index-scope.controller';
import { MarketIndexScopeService } from './market-index-scope.service';
import { IndexWeightSyncService } from '../index-weight/index-weight-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ThsIndexCatalogEntity, ThsMemberStockEntity, IndexWeightEntity]),
  ],
  controllers: [IndexCatalogSyncController, IndexCatalogController, MarketIndexScopeController],
  providers: [IndexCatalogSyncService, IndexCatalogQueryService, MarketIndexScopeService, TushareClientService, IndexWeightSyncService],
  exports: [IndexWeightSyncService],
})
export class IndexCatalogModule {}
