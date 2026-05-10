import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { IndexCatalogSyncController } from './index-catalog-sync.controller';
import { IndexCatalogSyncService } from './index-catalog-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ThsIndexCatalogEntity, ThsMemberStockEntity]),
  ],
  controllers: [IndexCatalogSyncController],
  providers: [IndexCatalogSyncService, TushareClientService],
})
export class IndexCatalogModule {}
