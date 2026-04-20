import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { BacktestDataService } from './engine/data.service';
import { CandleLogController } from './candle-log.controller';
import { KlineChartController } from './kline-chart.controller';
import { BacktestRunEntity } from '../entities/backtest/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest/backtest-trade.entity';
import { BacktestCandleLogEntity } from '../entities/backtest/backtest-candle-log.entity';
import { StrategyEntity } from '../entities/strategy/strategy.entity';
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
  controllers: [BacktestController, CandleLogController, KlineChartController],
  providers: [BacktestService, BacktestDataService],
  exports: [BacktestService],
})
export class BacktestModule {}
