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
import type { EtfSyncResult, EtfSyncOnProgress } from './etf.types';

export interface EtfSyncOptions {
  startDate: string;
  endDate: string;
  /**
   * 同步模式：'incremental'（默认）| 'overwrite'。
   * 仅影响 PCF 抓取（overwrite 时绕过 getExistingPcfCodes 增量跳过，重抓全部 ETF）；
   * fund_daily 与指标重算本就按 trade_date 全量重拉/重算，与 syncMode 无关。
   */
  syncMode?: 'incremental' | 'overwrite';
  /** 一键同步注入的进度回调（可选）；4 个子步骤按权重映射到全局区间。 */
  onProgress?: EtfSyncOnProgress;
  /** 中断信号：在子步骤之间检查，支持一键同步取消。 */
  signal?: AbortSignal;
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
    const { onProgress } = opts;
    const allErrors: EtfSyncResult['errors'] = [];
    let totalSuccess = 0;

    // 1. ETF 目录（0-5%）
    if (opts.signal?.aborted) throw new DOMException('Sync aborted', 'AbortError');
    onProgress?.({ phase: '同步 ETF 目录', percent: 0 });
    this.logger.log('[etf] Step 1/4: 同步 ETF 目录');
    const catalogResult = await this.catalogService.syncCatalog();
    allErrors.push(...catalogResult.errors);
    totalSuccess += catalogResult.success;
    onProgress?.({ phase: '同步 ETF 目录', percent: 5 });

    // 2. 获取跟踪的 ETF
    const trackedCodes = await this.catalogService.getTrackedEtfCodes();
    if (trackedCodes.length === 0) {
      this.logger.warn('[etf] 无跟踪的 ETF，跳过后续步骤');
      onProgress?.({ phase: '无跟踪 ETF', percent: 100 });
      return { success: totalSuccess, errors: allErrors };
    }

    // 3. fund_daily 日线（5-30%）
    if (opts.signal?.aborted) throw new DOMException('Sync aborted', 'AbortError');
    this.logger.log(`[etf] Step 2/4: 同步 ${trackedCodes.length} 只 ETF 日线`);
    const dailyResult = await this.fundDailyService.syncFundDaily(
      trackedCodes,
      opts.startDate,
      opts.endDate,
      onProgress ? mapRange(onProgress, '同步 ETF 日线', 5, 30) : undefined,
      opts.signal,
    );
    allErrors.push(...dailyResult.errors);
    totalSuccess += dailyResult.success;

    // 4. PCF 抓取（仅对成功抓到日线的 ETF；30-80%）
    const codesWithDaily = await this.fundDailyService.getEtfCodesWithDaily(
      trackedCodes,
      opts.startDate,
      opts.endDate,
    );
    if (codesWithDaily.size > 0) {
      this.logger.log(`[etf] Step 3/4: 抓取 ${codesWithDaily.size} 只 ETF PCF`);
      const pcfCodes = [...codesWithDaily].sort();
      const pcfResult = await this.pcfService.syncPcf(
        pcfCodes,
        opts.endDate,
        opts.syncMode,
        onProgress ? mapRange(onProgress, '同步 ETF PCF', 30, 80) : undefined,
        opts.signal,
      );
      allErrors.push(...pcfResult.errors);
      totalSuccess += pcfResult.success;
    } else {
      this.logger.warn('[etf] 无成功抓到日线的 ETF，跳过 PCF');
      onProgress?.({ phase: '跳过 PCF（无日线数据）', percent: 80 });
    }

    // 5. 技术指标收尾（80-100%）
    if (opts.signal?.aborted) throw new DOMException('Sync aborted', 'AbortError');
    this.logger.log('[etf] Step 4/4: 计算技术指标');
    const indicatorResult = await this.indicatorService.recalculateIndicators(
      [...codesWithDaily].sort(),
      onProgress ? mapRange(onProgress, '计算技术指标', 80, 100) : undefined,
      opts.signal,
    );
    allErrors.push(...indicatorResult.errors);
    totalSuccess += indicatorResult.success;

    onProgress?.({ phase: '完成', percent: 100 });
    this.logger.log(`[etf] 完成：总计 ${totalSuccess} 行，错误 ${allErrors.length}`);
    return { success: totalSuccess, errors: allErrors };
  }
}

/** 把子 service 的 0-100 进度线性映射到全局 [lo, hi] 区间。 */
function mapRange(
  onProgress: EtfSyncOnProgress,
  phase: string,
  lo: number,
  hi: number,
): EtfSyncOnProgress {
  return (p) =>
    onProgress({ phase, percent: lo + (p.percent / 100) * (hi - lo), message: p.message });
}
