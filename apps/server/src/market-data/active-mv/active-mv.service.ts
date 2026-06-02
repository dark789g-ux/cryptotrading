import { Injectable } from '@nestjs/common'
import { StockAmvService } from './stock-amv.service'
import { ThsIndexAmvService } from './industry-amv.service'
import type {
  AmvSeriesRow,
  AmvSignalRow,
  AmvSyncResult,
  StockAmvSyncOptions,
  ThsIndexAmvSyncOptions,
} from './active-mv.types'

/**
 * 活跃市值（AMV）协调服务。
 *
 * 薄封装：把 controller 的调用分派到个股 / 同花顺指数（行业 type='I' / 概念 type='N'）子服务。
 * 行业与概念共用同一 ThsIndexAmvService，按 type 落到 industry_amv_daily / concept_amv_daily。
 */
@Injectable()
export class ActiveMvService {
  constructor(
    private readonly stockAmv: StockAmvService,
    private readonly thsIndexAmv: ThsIndexAmvService,
  ) {}

  // ---- 个股 ----
  syncStock(opts: StockAmvSyncOptions): Promise<AmvSyncResult> {
    return this.stockAmv.syncStock(opts)
  }

  getStock(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    return this.stockAmv.getStock(tsCode, days)
  }

  getStockSignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.stockAmv.getStockSignals(tradeDate)
  }

  // ---- 行业（type='I'） ----
  syncIndustry(opts: ThsIndexAmvSyncOptions): Promise<AmvSyncResult> {
    return this.thsIndexAmv.syncIndustry(opts)
  }

  getIndustry(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    return this.thsIndexAmv.getIndustry(tsCode, days)
  }

  getIndustrySignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.thsIndexAmv.getIndustrySignals(tradeDate)
  }

  // ---- 概念/板块（type='N'） ----
  syncConcept(opts: ThsIndexAmvSyncOptions): Promise<AmvSyncResult> {
    return this.thsIndexAmv.syncConcept(opts)
  }

  getConcept(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    return this.thsIndexAmv.getConcept(tsCode, days)
  }

  getConceptSignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.thsIndexAmv.getConceptSignals(tradeDate)
  }
}
