import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegimeStrategyConfigEntity } from '../../entities/strategy/regime-strategy-config.entity';
import { RegimeDailyPickEntity } from '../../entities/strategy/regime-daily-pick.entity';
import { RegimeBacktestRunEntity } from '../../entities/strategy/regime-backtest-run.entity';
import { RegimeBacktestDailyEntity } from '../../entities/strategy/regime-backtest-daily.entity';
import { RegimeBacktestTradeEntity } from '../../entities/strategy/regime-backtest-trade.entity';
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { StrategyConditionsModule } from '../../strategy-conditions/strategy-conditions.module';
import { RegimeEngineController } from './regime-engine.controller';
import { RegimeEngineService } from './regime-engine.service';
import { RegimeBacktestDataLoader } from './backtest/regime-backtest.data-loader';
import { RegimeBacktestRunner } from './backtest/regime-backtest.runner';
import { RegimeBacktestService } from './backtest/regime-backtest.service';
import { RegimeBacktestController } from './backtest/regime-backtest.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegimeStrategyConfigEntity,
      RegimeDailyPickEntity,
      RegimeBacktestRunEntity,
      RegimeBacktestDailyEntity,
      RegimeBacktestTradeEntity,
      OamvDailyEntity,
      AShareSymbolEntity,
    ]),
    StrategyConditionsModule,
  ],
  controllers: [RegimeEngineController, RegimeBacktestController],
  providers: [RegimeEngineService, RegimeBacktestDataLoader, RegimeBacktestRunner, RegimeBacktestService],
})
export class RegimeEngineModule {}
