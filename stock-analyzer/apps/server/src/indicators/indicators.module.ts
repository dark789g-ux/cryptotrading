import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndicatorsService } from './indicators.service';
import { Indicator } from '../stocks/entities/indicator.entity';
import { StockPrice } from '../stocks/entities/stock-price.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Indicator, StockPrice])],
  providers: [IndicatorsService],
  exports: [IndicatorsService],
})
export class IndicatorsModule {}
