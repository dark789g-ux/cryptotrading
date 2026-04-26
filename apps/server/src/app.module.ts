import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SymbolsModule } from './catalog/symbols/symbols.module';
import { KlinesModule } from './market-data/klines/klines.module';
import { SyncModule } from './market-data/sync/sync.module';
import { StrategiesModule } from './strategies/strategies.module';
import { BacktestModule } from './backtest/backtest.module';
import { WatchlistsModule } from './catalog/watchlists/watchlists.module';
import { SymbolPresetsModule } from './catalog/symbol-presets/symbol-presets.module';
import { SettingsModule } from './settings/settings.module';
import { ASharesModule } from './market-data/a-shares/a-shares.module';
import { SymbolEntity } from './entities/symbol/symbol.entity';
import { KlineEntity } from './entities/kline.entity';
import { AShareSymbolEntity } from './entities/a-share/a-share-symbol.entity';
import { AShareDailyQuoteEntity } from './entities/a-share/a-share-daily-quote.entity';
import { AShareDailyMetricEntity } from './entities/a-share/a-share-daily-metric.entity';
import { StrategyTypeEntity } from './entities/strategy/strategy-type.entity';
import { StrategyEntity } from './entities/strategy/strategy.entity';
import { BacktestRunEntity } from './entities/backtest/backtest-run.entity';
import { BacktestTradeEntity } from './entities/backtest/backtest-trade.entity';
import { BacktestCandleLogEntity } from './entities/backtest/backtest-candle-log.entity';
import { WatchlistEntity } from './entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from './entities/watchlist/watchlist-item.entity';
import { SymbolPresetEntity } from './entities/symbol/symbol-preset.entity';
import { SymbolPresetItemEntity } from './entities/symbol/symbol-preset-item.entity';
import { AppConfigEntity } from './entities/app-config.entity';
import { seedStrategyTypes } from './strategies/strategy-types.seed';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get('DB_USER', 'cryptouser'),
        password: config.get('DB_PASS', 'cryptopass'),
        database: config.get('DB_NAME', 'cryptodb'),
        entities: [
          SymbolEntity,
          KlineEntity,
          AShareSymbolEntity,
          AShareDailyQuoteEntity,
          AShareDailyMetricEntity,
          StrategyTypeEntity,
          StrategyEntity,
          BacktestRunEntity,
          BacktestTradeEntity,
          BacktestCandleLogEntity,
          WatchlistEntity,
          WatchlistItemEntity,
          SymbolPresetEntity,
          SymbolPresetItemEntity,
          AppConfigEntity,
        ],
        synchronize: false,
        logging: ['error', 'warn'],
      }),
      inject: [ConfigService],
    }),
    SymbolsModule,
    KlinesModule,
    SyncModule,
    StrategiesModule,
    BacktestModule,
    WatchlistsModule,
    SymbolPresetsModule,
    SettingsModule,
    ASharesModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit() {
    await seedStrategyTypes(this.dataSource);
  }
}
