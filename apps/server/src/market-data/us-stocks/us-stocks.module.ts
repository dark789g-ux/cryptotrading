import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsSymbolEntity } from '../../entities/raw/us-symbol.entity';
import { UsDailyQuoteEntity } from '../../entities/raw/us-daily-quote.entity';
import { UsAdjFactorEntity } from '../../entities/raw/us-adj-factor.entity';
import { UsDailyIndicatorEntity } from '../../entities/raw/us-daily-indicator.entity';
import { QuantModule } from '../../modules/quant/quant.module';
import { UsStocksController } from './us-stocks.controller';
import { UsStocksService } from './us-stocks.service';
import { UsStocksSymbolsService } from './us-stocks-symbols.service';

/**
 * 美股 Tab 查询 + 触发模块（spec 2026-06-16-us-stocks-tab-design 05）。
 *
 * 只读 raw.us_*（query/summary/filterOptions/dateRange/klines）+ 写 us_symbol.tracked
 * + 派 ml.jobs(run_type='us_sync')。不算任何衍生数据。
 *
 * 4 实体已在 app.module.ts 根 entities[] 注册（双注册），此处 forFeature 供 repo 注入。
 * QuantModule 导出 QuantJobsService，供 sync 派 job 复用既有创建逻辑。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UsSymbolEntity,
      UsDailyQuoteEntity,
      UsAdjFactorEntity,
      UsDailyIndicatorEntity,
    ]),
    QuantModule,
  ],
  controllers: [UsStocksController],
  providers: [UsStocksService, UsStocksSymbolsService],
  exports: [UsStocksService],
})
export class UsStocksModule {}
