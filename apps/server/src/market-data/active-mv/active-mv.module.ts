import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { IndexMemberEntity } from '../../entities/raw/index-member.entity'
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity'
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity'
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import { IndustryAmvDailyEntity } from '../../entities/active-mv/industry-amv-daily.entity'
import { ConceptAmvDailyEntity } from '../../entities/active-mv/concept-amv-daily.entity'
import { SwAmvDailyEntity } from '../../entities/active-mv/sw-amv-daily.entity'
import { AmvCalcStateEntity } from '../../entities/raw/amv-calc-state.entity'
import { ActiveMvController } from './active-mv.controller'
import { ActiveMvService } from './active-mv.service'
import { StockAmvService } from './stock-amv.service'
import { ThsIndexAmvService } from './industry-amv.service'
import { SwAmvService } from './sw-amv.service'

/**
 * 活跃市值（AMV）模块。spec §6。
 * 读本地表 + 写四张 amv 宽表（stock / industry / concept / sw）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StockAmvDailyEntity,
      IndustryAmvDailyEntity,
      ConceptAmvDailyEntity,
      SwAmvDailyEntity,
      DailyQuoteEntity,
      IndexMemberEntity,
      ThsMemberStockEntity,
      ThsIndexCatalogEntity,
      SwIndexCatalogEntity,
      IndexDailyQuoteEntity,
      AmvCalcStateEntity,
    ]),
  ],
  controllers: [ActiveMvController],
  providers: [ActiveMvService, StockAmvService, ThsIndexAmvService, SwAmvService],
  exports: [ActiveMvService],
})
export class ActiveMvModule {}
