import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegimeStrategyConfigEntity } from '../../entities/strategy/regime-strategy-config.entity';
import { RegimeDailyPickEntity } from '../../entities/strategy/regime-daily-pick.entity';
import { RegimeBacktestRunEntity } from '../../entities/strategy/regime-backtest-run.entity';
import { RegimeBacktestDailyEntity } from '../../entities/strategy/regime-backtest-daily.entity';
import { RegimeBacktestDailyLogEntity } from '../../entities/strategy/regime-backtest-daily-log.entity';
import { RegimeBacktestTradeEntity } from '../../entities/strategy/regime-backtest-trade.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { StrategyConditionsModule } from '../../strategy-conditions/strategy-conditions.module';
import { ASharesModule } from '../../market-data/a-shares/a-shares.module';
import { RegimeEngineController } from './regime-engine.controller';
import { RegimeEngineService } from './regime-engine.service';
import { RegimeBacktestDataLoader } from './backtest/regime-backtest.data-loader';
import { RegimeBacktestRunner } from './backtest/regime-backtest.runner';
import { RegimeBacktestService } from './backtest/regime-backtest.service';
import { RegimeBacktestController } from './backtest/regime-backtest.controller';
import { RegimeBacktestAshareController } from './backtest/regime-backtest-ashare.controller';
import { CalendarLoader } from './backtest/loaders/calendar.loader';
import { MarketSnapshotLoader } from './backtest/loaders/market-snapshot.loader';
import { SignalEnumerator } from './backtest/loaders/signal-enumerator';
import { SymbolMetaLoader } from './backtest/loaders/symbol-meta.loader';
import { QuoteLoader } from './backtest/loaders/quote.loader';
import { ExitSignalLoader } from './backtest/loaders/exit-signal.loader';
import { WindowBuilder } from './backtest/window/window.builder';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegimeStrategyConfigEntity,
      RegimeDailyPickEntity,
      RegimeBacktestRunEntity,
      RegimeBacktestDailyEntity,
      RegimeBacktestDailyLogEntity,
      RegimeBacktestTradeEntity,
      AShareSymbolEntity,
    ]),
    StrategyConditionsModule,
    ASharesModule,
  ],
  controllers: [RegimeEngineController, RegimeBacktestController, RegimeBacktestAshareController],
  providers: [
    RegimeEngineService,
    RegimeBacktestDataLoader,
    RegimeBacktestRunner,
    RegimeBacktestService,
    CalendarLoader,
    MarketSnapshotLoader,
    SignalEnumerator,
    SymbolMetaLoader,
    QuoteLoader,
    ExitSignalLoader,
    WindowBuilder,
  ],
})
export class RegimeEngineModule {}
