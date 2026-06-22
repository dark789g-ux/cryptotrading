import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity'
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import { IndustryAmvDailyEntity } from '../../entities/active-mv/industry-amv-daily.entity'
import { ConceptAmvDailyEntity } from '../../entities/active-mv/concept-amv-daily.entity'
import { ActiveMvController } from './active-mv.controller'
import { ActiveMvService } from './active-mv.service'
import { StockAmvService } from './stock-amv.service'
import { ThsIndexAmvService } from './industry-amv.service'

/**
 * 活跃市值（AMV）模块。spec §6。
 * 仅读本地表（raw.daily_quote / ths_member_stocks / ths_index_catalog / index_daily_quotes）
 * + 写三张 amv 宽表（stock / industry(type=I) / concept(type=N)）；
 * 本模块不直连 Tushare（成分股补采是 §0 独立 gate）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StockAmvDailyEntity,
      IndustryAmvDailyEntity,
      ConceptAmvDailyEntity,
      DailyQuoteEntity,
      ThsMemberStockEntity,
      ThsIndexCatalogEntity,
      IndexDailyQuoteEntity,
    ]),
  ],
  controllers: [ActiveMvController],
  providers: [ActiveMvService, StockAmvService, ThsIndexAmvService],
  exports: [ActiveMvService],
})
export class ActiveMvModule {}
