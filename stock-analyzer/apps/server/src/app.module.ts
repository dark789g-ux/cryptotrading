import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module';
import { StocksModule } from './stocks/stocks.module';
import { IndicatorsModule } from './indicators/indicators.module';
import { WatchlistsModule } from './watchlists/watchlists.module';
import { BacktestModule } from './backtest/backtest.module';
import { DataSyncModule } from './data-sync/data-sync.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      username: process.env.DB_USER || 'stockuser',
      password: process.env.DB_PASS || 'stockpass',
      database: process.env.DB_NAME || 'stockdb',
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: process.env.NODE_ENV !== 'production',
    }),
    ScheduleModule.forRoot(),
    StocksModule,
    IndicatorsModule,
    WatchlistsModule,
    BacktestModule,
    DataSyncModule,
  ],
})
export class AppModule {}
