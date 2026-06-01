import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity'
import { ThsIndexDailyQuoteEntity } from '../../entities/ths-index-daily/ths-index-daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import { IndustryAmvDailyEntity } from '../../entities/active-mv/industry-amv-daily.entity'
import { ActiveMvController } from './active-mv.controller'
import { ActiveMvService } from './active-mv.service'
import { StockAmvService } from './stock-amv.service'
import { IndustryAmvService } from './industry-amv.service'

/**
 * 活跃市值（AMV）模块。spec §6。
 * 仅读本地表（raw.daily_quote / ths_member_stocks / ths_index_daily_quotes）+ 写两张 amv 宽表；
 * 本模块不直连 Tushare（成分股补采是 §0 独立 gate）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StockAmvDailyEntity,
      IndustryAmvDailyEntity,
      DailyQuoteEntity,
      ThsMemberStockEntity,
      ThsIndexDailyQuoteEntity,
    ]),
  ],
  controllers: [ActiveMvController],
  providers: [ActiveMvService, StockAmvService, IndustryAmvService],
})
export class ActiveMvModule {}
