import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestService } from './backtest.service';
import { BacktestController } from './backtest.controller';
import { StockPrice } from '../stocks/entities/stock-price.entity';
import { Indicator } from '../stocks/entities/indicator.entity';

@Module({
  imports: [TypeOrmModule.forFeature([StockPrice, Indicator])],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}