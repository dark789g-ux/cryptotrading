import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';

/**
 * 统一 A 股指数日线模块（骨架）。
 * spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md
 *
 * 注册 IndexDailyQuote/Indicator 两个实体。latest 最新行情 + kline K 线查询的
 * service/controller 由 T4 批次2 补充；旧路径 /ths-index-daily 的查询（含薄封装
 * WHERE category IN industry/concept）仍由 ThsIndexDailyModule 提供。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IndexDailyQuoteEntity, IndexDailyIndicatorEntity]),
  ],
})
export class IndexDailyModule {}
