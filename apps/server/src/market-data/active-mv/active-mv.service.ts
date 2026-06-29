import { Injectable } from '@nestjs/common'
import { StockAmvService } from './stock-amv.service'
import { ThsIndexAmvService } from './industry-amv.service'
import { SwAmvService } from './sw-amv.service'
import type { AmvSeriesRange } from './amv-series-query'
import type {
  AmvSeriesRow,
  AmvSignalRow,
  AmvSyncResult,
  StockAmvSyncOptions,
  SwIndexAmvSyncOptions,
  ThsIndexAmvSyncOptions,
} from './active-mv.types'

/**
 * 活跃市值（AMV）协调服务。
 *
 * 薄封装：把 controller 的调用分派到个股 / 同花顺指数（行业 type='I' / 概念 type='N'）/ 申万 SW 子服务。
 */
@Injectable()
export class ActiveMvService {
  constructor(
    private readonly stockAmv: StockAmvService,
    private readonly thsIndexAmv: ThsIndexAmvService,
    private readonly swAmv: SwAmvService,
  ) {}

  // ---- 个股 ----
  syncStock(opts: StockAmvSyncOptions): Promise<AmvSyncResult> {
    return this.stockAmv.syncStock(opts)
  }

  /**
   * 个股 AMV dirty 续算（PR-7③-b：a-shares-sync 收尾调用）。满足⑥判据「嵌入」三条件
   * （单源 daily_quote + 1:1 + dirty 续算），并入 a-shares 同步收尾，不再独立成 Step6。
   */
  recalculateDirtyStockAmv(
    tsCodes: string[],
    onProgress?: (current: number, total: number, tsCode: string) => void,
  ): Promise<{ synced: number; failedItems: NonNullable<AmvSyncResult['failedItems']> }> {
    return this.stockAmv.recalculateDirtyAmvForSymbols(tsCodes, onProgress)
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

  getIndustry(
    tsCode: string,
    days: number,
    range?: AmvSeriesRange,
  ): Promise<AmvSeriesRow[]> {
    return this.thsIndexAmv.getIndustry(tsCode, days, range)
  }

  getIndustrySignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.thsIndexAmv.getIndustrySignals(tradeDate)
  }

  // ---- 概念/板块（type='N'） ----
  syncConcept(opts: ThsIndexAmvSyncOptions): Promise<AmvSyncResult> {
    return this.thsIndexAmv.syncConcept(opts)
  }

  getConcept(
    tsCode: string,
    days: number,
    range?: AmvSeriesRange,
  ): Promise<AmvSeriesRow[]> {
    return this.thsIndexAmv.getConcept(tsCode, days, range)
  }

  getConceptSignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.thsIndexAmv.getConceptSignals(tradeDate)
  }

  // ---- 申万指数（.SI） ----
  syncSw(opts: SwIndexAmvSyncOptions): Promise<AmvSyncResult> {
    return this.swAmv.syncSw(opts)
  }

  getSw(
    tsCode: string,
    days: number,
    range?: AmvSeriesRange,
  ): Promise<AmvSeriesRow[]> {
    return this.swAmv.getSw(tsCode, days, range)
  }
}
