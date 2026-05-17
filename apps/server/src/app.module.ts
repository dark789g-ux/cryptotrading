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
import { PreferencesModule } from './preferences/preferences.module';
import { ASharesModule } from './market-data/a-shares/a-shares.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SymbolEntity } from './entities/symbol/symbol.entity';
import { KlineEntity } from './entities/symbol/kline.entity';
import { AShareSymbolEntity } from './entities/a-share/a-share-symbol.entity';
import { DailyQuoteEntity } from './entities/raw/daily-quote.entity';
import { DailyBasicEntity } from './entities/raw/daily-basic.entity';
import { DailyIndicatorEntity } from './entities/raw/daily-indicator.entity';
import { AdjFactorEntity } from './entities/raw/adj-factor.entity';
import { IndicatorCalcStateEntity } from './entities/raw/indicator-calc-state.entity';
import { AShareSyncStateEntity } from './entities/a-share/a-share-sync-state.entity';
import { AShareFilterPresetEntity } from './entities/a-share/a-share-filter-preset.entity';
import { StrategyTypeEntity } from './entities/strategy/strategy-type.entity';
import { StrategyEntity } from './entities/strategy/strategy.entity';
import { BacktestRunEntity } from './entities/backtest/backtest-run.entity';
import { BacktestTradeEntity } from './entities/backtest/backtest-trade.entity';
import { BacktestCandleLogEntity } from './entities/backtest/backtest-candle-log.entity';
import { WatchlistEntity } from './entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from './entities/watchlist/watchlist-item.entity';
import { SymbolPresetEntity } from './entities/symbol/symbol-preset.entity';
import { SymbolPresetItemEntity } from './entities/symbol/symbol-preset-item.entity';
import { AppConfigEntity } from './entities/config/app-config.entity';
import { UserPreferenceEntity } from './entities/config/user-preference.entity';
import { UserEntity } from './users/entities/user.entity';
import { AuthSessionEntity } from './auth/entities/auth-session.entity';
import { UserInvitationEntity } from './users/entities/user-invitation.entity';
import { StrategyConditionEntity } from './entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from './entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from './entities/strategy/strategy-condition-hit.entity';
import { StrategyConditionsModule } from './strategy-conditions/strategy-conditions.module';
import { MoneyFlowStockEntity } from './entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from './entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from './entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from './entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from './entities/money-flow/ths-member-stock.entity';
import { ThsIndexCatalogEntity } from './entities/index-catalog/ths-index-catalog.entity';
import { ThsIndexDailyQuoteEntity } from './entities/ths-index-daily/ths-index-daily-quote.entity';
import { ThsIndexDailyIndicatorEntity } from './entities/ths-index-daily/ths-index-daily-indicator.entity';
import { MoneyFlowModule } from './market-data/money-flow/money-flow.module';
import { IndexCatalogModule } from './market-data/index-catalog/index-catalog.module';
import { ThsIndexDailyModule } from './market-data/ths-index-daily/ths-index-daily.module';
import { OamvModule } from './market-data/oamv/oamv.module';
import { OamvDailyEntity } from './entities/oamv/oamv-daily.entity';
import { DailyReviewEntity } from './entities/daily-review/daily-review.entity';
import { MacroEventEntity } from './entities/macro-event/macro-event.entity';
import { DailyReviewModule } from './daily-review/daily-review.module';
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
          DailyQuoteEntity,
          DailyBasicEntity,
          DailyIndicatorEntity,
          AdjFactorEntity,
          IndicatorCalcStateEntity,
          AShareSyncStateEntity,
          AShareFilterPresetEntity,
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
          UserPreferenceEntity,
          UserEntity,
          AuthSessionEntity,
          UserInvitationEntity,
          StrategyConditionEntity,
          StrategyConditionRunEntity,
          StrategyConditionHitEntity,
          MoneyFlowStockEntity,
          MoneyFlowIndustryEntity,
          MoneyFlowSectorEntity,
          MoneyFlowMarketEntity,
          ThsMemberStockEntity,
          ThsIndexCatalogEntity,
          ThsIndexDailyQuoteEntity,
          ThsIndexDailyIndicatorEntity,
          OamvDailyEntity,
          DailyReviewEntity,
          MacroEventEntity,
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
    PreferencesModule,
    ASharesModule,
    AuthModule,
    UsersModule,
    StrategyConditionsModule,
    MoneyFlowModule,
    IndexCatalogModule,
    ThsIndexDailyModule,
    OamvModule,
    DailyReviewModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit() {
    await seedStrategyTypes(this.dataSource);
  }
}
