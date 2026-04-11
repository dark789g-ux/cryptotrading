import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSyncService } from './data-sync.service';
import { Stock } from '../stocks/entities/stock.entity';
import { StockPrice } from '../stocks/entities/stock-price.entity';
import { IndicatorsModule } from '../indicators/indicators.module';

@Module({
  imports: [TypeOrmModule.forFeature([Stock, StockPrice]), IndicatorsModule],
  providers: [DataSyncService],
  exports: [DataSyncService],
})
export class DataSyncModule {}
