/**
 * ETF 主 service：编排 ETF 目录 → fund_daily → PCF → 技术指标。
 *
 * 内部顺序：
 * 1. ETF 目录（seed / fund_basic）
 * 2. fund_daily 日线（仅跟踪的 ETF）
 * 3. 基于成功抓到日线的 ETF 集合抓 PCF
 * 4. 技术指标收尾
 */
import { Injectable, Logger } from '@nestjs/common';
import { EtfCatalogService } from './etf-catalog.service';
import { EtfFundDailyService } from './etf-fund-daily.service';
import { EtfPcfService } from './etf-pcf.service';
import { EtfIndicatorService } from './etf-indicator.service';
import type { EtfSyncResult } from './etf.types';

export interface EtfSyncOptions {
  startDate: string;
  endDate: string;
  /**
   * 同步模式：'incremental'（默认）| 'overwrite'。
   * 仅影响 PCF 抓取（overwrite 时绕过 getExistingPcfCodes 增量跳过，重抓全部 ETF）；
   * fund_daily 与指标重算本就按 trade_date 全量重拉/重算，与 syncMode 无关。
   */
  syncMode?: 'incremental' | 'overwrite';
}

@Injectable()
export class EtfService {
  private readonly logger = new Logger(EtfService.name);

  constructor(
    private readonly catalogService: EtfCatalogService,
    private readonly fundDailyService: EtfFundDailyService,
    private readonly pcfService: EtfPcfService,
    private readonly indicatorService: EtfIndicatorService,
  ) {}

  /**
   * 执行 ETF 全量同步。
   * 返回总成功行数 + 汇总错误。
   */
  async sync(opts: EtfSyncOptions): Promise<EtfSyncResult> {
    const allErrors: EtfSyncResult['errors'] = [];
    let totalSuccess = 0;

    // 1. ETF 目录
    this.logger.log('[etf] Step 1/4: 同步 ETF 目录');
    const catalogResult = await this.catalogService.syncCatalog();
    allErrors.push(...catalogResult.errors);
    totalSuccess += catalogResult.success;

    // 2. 获取跟踪的 ETF
    const trackedCodes = await this.catalogService.getTrackedEtfCodes();
    if (trackedCodes.length === 0) {
      this.logger.warn('[etf] 无跟踪的 ETF，跳过后续步骤');
      return { success: totalSuccess, errors: allErrors };
    }

    // 3. fund_daily 日线
    this.logger.log(`[etf] Step 2/4: 同步 ${trackedCodes.length} 只 ETF 日线`);
    const dailyResult = await this.fundDailyService.syncFundDaily(
      trackedCodes,
      opts.startDate,
      opts.endDate,
    );
    allErrors.push(...dailyResult.errors);
    totalSuccess += dailyResult.success;

    // 4. PCF 抓取（仅对成功抓到日线的 ETF）
    const codesWithDaily = await this.fundDailyService.getEtfCodesWithDaily(
      trackedCodes,
      opts.startDate,
      opts.endDate,
    );
    if (codesWithDaily.size > 0) {
      this.logger.log(`[etf] Step 3/4: 抓取 ${codesWithDaily.size} 只 ETF PCF`);
      const pcfCodes = [...codesWithDaily].sort();
      const pcfResult = await this.pcfService.syncPcf(pcfCodes, opts.endDate, opts.syncMode);
      allErrors.push(...pcfResult.errors);
      totalSuccess += pcfResult.success;
    } else {
      this.logger.warn('[etf] 无成功抓到日线的 ETF，跳过 PCF');
    }

    // 5. 技术指标收尾
    this.logger.log('[etf] Step 4/4: 计算技术指标');
    const indicatorResult = await this.indicatorService.recalculateIndicators(
      [...codesWithDaily].sort(),
    );
    allErrors.push(...indicatorResult.errors);
    totalSuccess += indicatorResult.success;

    this.logger.log(`[etf] 完成：总计 ${totalSuccess} 行，错误 ${allErrors.length}`);
    return { success: totalSuccess, errors: allErrors };
  }
}
