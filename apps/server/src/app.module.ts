import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SymbolsModule } from './symbols/symbols.module';
import { KlinesModule } from './klines/klines.module';
import { SyncModule } from './sync/sync.module';
import { StrategiesModule } from './strategies/strategies.module';
import { BacktestModule } from './backtest/backtest.module';
import { WatchlistsModule } from './watchlists/watchlists.module';
import { SymbolPresetsModule } from './symbol-presets/symbol-presets.module';
import { SettingsModule } from './settings/settings.module';
import { SymbolEntity } from './entities/symbol.entity';
import { KlineEntity } from './entities/kline.entity';
import { StrategyTypeEntity } from './entities/strategy-type.entity';
import { StrategyEntity } from './entities/strategy.entity';
import { BacktestRunEntity } from './entities/backtest-run.entity';
import { BacktestTradeEntity } from './entities/backtest-trade.entity';
import { BacktestCandleLogEntity } from './entities/backtest-candle-log.entity';
import { WatchlistEntity } from './entities/watchlist.entity';
import { WatchlistItemEntity } from './entities/watchlist-item.entity';
import { SymbolPresetEntity } from './entities/symbol-preset.entity';
import { SymbolPresetItemEntity } from './entities/symbol-preset-item.entity';
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
  ],
})
export class AppModule implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit() {
    await seedStrategyTypes(this.dataSource);
  }
}
