import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { BacktestDataService } from './engine/data.service';
import { CandleLogController } from './candle-log.controller';
import { BacktestRunEntity } from '../entities/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest-trade.entity';
import { BacktestCandleLogEntity } from '../entities/backtest-candle-log.entity';
import { StrategyEntity } from '../entities/strategy.entity';
import { KlineEntity } from '../entities/kline.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BacktestRunEntity,
      BacktestTradeEntity,
      BacktestCandleLogEntity,
      StrategyEntity,
      KlineEntity,
    ]),
  ],
  controllers: [BacktestController, CandleLogController],
  providers: [BacktestService, BacktestDataService],
  exports: [BacktestService],
})
export class BacktestModule {}
