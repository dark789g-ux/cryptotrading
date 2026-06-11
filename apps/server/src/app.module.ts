import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { REPO_ENV_PATH } from './env-file-path';
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
import { TradeCalEntity } from './entities/raw/trade-cal.entity';
import { StkLimitEntity } from './entities/raw/stk-limit.entity';
import { SuspendEntity } from './entities/raw/suspend.entity';
import { IndexClassifyEntity } from './entities/raw/index-classify.entity';
import { IndexMemberEntity } from './entities/raw/index-member.entity';
import { FinaIndicatorEntity } from './entities/raw/fina-indicator.entity';
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
import { SignalTestEntity } from './entities/strategy/signal-test.entity';
import { SignalTestRunEntity } from './entities/strategy/signal-test-run.entity';
import { SignalTestTradeEntity } from './entities/strategy/signal-test-trade.entity';
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
import { BaseDataSyncModule } from './market-data/base-data-sync/base-data-sync.module';
import { OamvModule } from './market-data/oamv/oamv.module';
import { OamvDailyEntity } from './entities/oamv/oamv-daily.entity';
import { ActiveMvModule } from './market-data/active-mv/active-mv.module';
import { SignalRollingIndicatorModule } from './market-data/signal-rolling-indicator/signal-rolling-indicator.module';
import { SignalRollingIndicatorEntity } from './entities/strategy/signal-rolling-indicator.entity';
import { StockAmvDailyEntity } from './entities/active-mv/stock-amv-daily.entity';
import { IndustryAmvDailyEntity } from './entities/active-mv/industry-amv-daily.entity';
import { ConceptAmvDailyEntity } from './entities/active-mv/concept-amv-daily.entity';
import { DailyReviewEntity } from './entities/daily-review/daily-review.entity';
import { MacroEventEntity } from './entities/macro-event/macro-event.entity';
import { DailyReviewModule } from './daily-review/daily-review.module';
import { QuantModule } from './modules/quant/quant.module';
import { MlJobEntity } from './entities/ml/ml-job.entity';
import { MlModelRunEntity } from './entities/ml/ml-model-run.entity';
import { MlScoreDailyEntity } from './entities/ml/ml-score-daily.entity';
import { MlQualityReportEntity } from './entities/ml/ml-quality-report.entity';
import { FactorDefinitionEntity } from './entities/ml/factor-definition.entity';
import { LabelDefinitionEntity } from './entities/ml/label-definition.entity';
import { StrategyDefinitionEntity } from './entities/ml/strategy-definition.entity';
import { FeatureSetEntity } from './entities/ml/feature-set.entity';
import { KellySweepResult } from './entities/ml/kelly-sweep-result.entity';
import { RegimeStrategyConfigEntity } from './entities/strategy/regime-strategy-config.entity';
import { RegimeDailyPickEntity } from './entities/strategy/regime-daily-pick.entity';
import { PortfolioSimRunEntity } from './entities/strategy/portfolio-sim-run.entity';
import { PortfolioSimDailyEntity } from './entities/strategy/portfolio-sim-daily.entity';
import { PortfolioSimFillEntity } from './entities/strategy/portfolio-sim-fill.entity';
import { RegimeEngineModule } from './strategies/regime-engine/regime-engine.module';
import { PortfolioSimModule } from './strategy-conditions/portfolio-sim/portfolio-sim.module';
import { seedStrategyTypes } from './strategies/strategy-types.seed';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: REPO_ENV_PATH,
    }),
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
          // ---- M1 Part C 新增：Python sync 拥有的 6 张 raw 表（只读 entity）----
          TradeCalEntity,
          StkLimitEntity,
          SuspendEntity,
          IndexClassifyEntity,
          IndexMemberEntity,
          FinaIndicatorEntity,
          // ----
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
          SignalTestEntity,
          SignalTestRunEntity,
          SignalTestTradeEntity,
          // signal_rolling_indicator（预计算滚动指标，spec 2026-06-09-signal-rolling-indicators-design）
          SignalRollingIndicatorEntity,
          MoneyFlowStockEntity,
          MoneyFlowIndustryEntity,
          MoneyFlowSectorEntity,
          MoneyFlowMarketEntity,
          ThsMemberStockEntity,
          ThsIndexCatalogEntity,
          ThsIndexDailyQuoteEntity,
          ThsIndexDailyIndicatorEntity,
          OamvDailyEntity,
          StockAmvDailyEntity,
          IndustryAmvDailyEntity,
          ConceptAmvDailyEntity,
          DailyReviewEntity,
          MacroEventEntity,
          // ---- M2 Part C 新增：ml.* 4 张表 entities（jobs 是写者，其余只读，service 留 M3） ----
          MlJobEntity,
          MlModelRunEntity,
          MlScoreDailyEntity,
          MlQualityReportEntity,
          // ----
          // factors.factor_definitions（因子元数据 admin API，新 spec 2026-05-23-factor-registry-frontend-design）
          FactorDefinitionEntity,
          // factors.label_definitions（标签定义 CRUD，新 spec 2026-06-05-quant-label-management-design）
          LabelDefinitionEntity,
          // factors.strategy_definitions（出场策略定义 CRUD，新 spec 2026-06-06-quant-strategy-management-design）
          StrategyDefinitionEntity,
          // factors.feature_sets（已物化特征集列表 API，新 spec 2026-06-06-labels-features-incremental-prepare-design）
          FeatureSetEntity,
          // research.kelly_sweep_results（凯利网格搜索结果表，spec 2026-06-09-kelly-sweep-web-console-design）
          KellySweepResult,
          // regime engine（0AMV 四象限每日选股，spec 2026-06-10-0amv-regime-strategy-design）
          RegimeStrategyConfigEntity,
          RegimeDailyPickEntity,
          // portfolio-level simulator（组合级模拟器数据层，spec portfolio-sim 03-data-model）
          PortfolioSimRunEntity,
          PortfolioSimDailyEntity,
          PortfolioSimFillEntity,
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
    RegimeEngineModule,
    BacktestModule,
    WatchlistsModule,
    SymbolPresetsModule,
    SettingsModule,
    PreferencesModule,
    ASharesModule,
    AuthModule,
    UsersModule,
    StrategyConditionsModule,
    PortfolioSimModule,
    MoneyFlowModule,
    IndexCatalogModule,
    ThsIndexDailyModule,
    BaseDataSyncModule,
    OamvModule,
    ActiveMvModule,
    SignalRollingIndicatorModule,
    DailyReviewModule,
    QuantModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit() {
    await seedStrategyTypes(this.dataSource);
  }
}
