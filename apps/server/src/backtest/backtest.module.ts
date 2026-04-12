import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { BacktestDataService } from './engine/data.service';
import { BacktestRunEntity } from '../entities/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest-trade.entity';
import { StrategyEntity } from '../entities/strategy.entity';
import { KlineEntity } from '../entities/kline.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BacktestRunEntity,
      BacktestTradeEntity,
      StrategyEntity,
      KlineEntity,
    ]),
  ],
  controllers: [BacktestController],
  providers: [BacktestService, BacktestDataService],
  exports: [BacktestService],
})
export class BacktestModule {}
