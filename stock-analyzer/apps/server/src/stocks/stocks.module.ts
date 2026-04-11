import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StocksService } from './stocks.service';
import { StocksController } from './stocks.controller';
import { Stock } from './entities/stock.entity';
import { StockPrice } from './entities/stock-price.entity';
import { Indicator } from './entities/indicator.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Stock, StockPrice, Indicator])],
  controllers: [StocksController],
  providers: [StocksService],
  exports: [StocksService],
})
export class StocksModule {}
