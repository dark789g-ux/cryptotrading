import { Injectable } from '@nestjs/common'
import { StockAmvService } from './stock-amv.service'
import { IndustryAmvService } from './industry-amv.service'
import type {
  AmvSeriesRow,
  AmvSignalRow,
  AmvSyncResult,
  IndustryAmvSyncOptions,
  StockAmvSyncOptions,
} from './active-mv.types'

/**
 * 活跃市值（AMV）协调服务。
 *
 * 薄封装：把 controller 的调用分派到个股 / 行业子服务。
 * 阶段 1 仅转发，真实算法在 stock-amv.service / industry-amv.service（阶段 2/3）填充。
 */
@Injectable()
export class ActiveMvService {
  constructor(
    private readonly stockAmv: StockAmvService,
    private readonly industryAmv: IndustryAmvService,
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

  // ---- 行业 ----
  syncIndustry(opts: IndustryAmvSyncOptions): Promise<AmvSyncResult> {
    return this.industryAmv.syncIndustry(opts)
  }

  getIndustry(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    return this.industryAmv.getIndustry(tsCode, days)
  }

  getIndustrySignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.industryAmv.getIndustrySignals(tradeDate)
  }
}
