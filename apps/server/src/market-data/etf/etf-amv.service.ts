/**
 * ETF AMV 活跃市值 service。
 *
 * 量侧 = ETF 成分股 raw.daily_quote 的 SUM(amount)
 * 价侧 = raw.fund_daily 的 ETF OHLC
 * 复用 active-mv/amv-formula.ts + amv-sync-helpers.ts
 * 落 raw.fund_amv_daily（同构 sw_amv_daily）
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FundAmvDailyEntity } from '../../entities/raw/fund-amv-daily.entity';
import { EtfPcfEntity } from '../../entities/raw/etf-pcf.entity';
import { FundDailyEntity } from '../../entities/raw/fund-daily.entity';
import { EtfSymbolEntity } from '../../entities/raw/etf-symbol.entity';
import {
  aggregateAmount,
  buildAmvDailyRows,
  persistAmvDaily,
} from '../active-mv/amv-sync-helpers';
import type { AmvDailyRow, AmvSyncMode } from '../active-mv/active-mv.types';
import type { EtfSyncErrorItem, EtfSyncResult, EtfSyncOnProgress } from './etf.types';

@Injectable()
export class EtfAmvService {
  private readonly logger = new Logger(EtfAmvService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 同步 ETF AMV。
   * 对每只有日线 + PCF 成分股数据的 ETF 计算活跃市值。
   *
   * syncMode 透传至 persistAmvDaily（amv-sync-helpers 共享 helper，与 sw/industry/concept-amv 同构）：
   * - 'incremental'（默认）：按 tsCode 查现有 tradeDate，跳过已入库行。
   * - 'overwrite'：不查现有，全部 upsert 重写（重算所有、不按 (tsCode,tradeDate) 跳过已有）。
   */
  async sync(
    etfCodes: string[],
    startDate: string,
    endDate: string,
    syncMode?: 'incremental' | 'overwrite',
    onProgress?: EtfSyncOnProgress,
  ): Promise<EtfSyncResult> {
    const amvRepo = this.dataSource.getRepository(FundAmvDailyEntity);
    const errors: EtfSyncErrorItem[] = [];
    let totalWritten = 0;
    this.logger.log(`[etf-amv] 开始：${etfCodes.length || '自动获取'} 只 ETF，范围 ${startDate}~${endDate}，模式 ${syncMode ?? 'incremental'}`);

    // 如果未传 ETF 代码，自动获取跟踪的 ETF
    if (etfCodes.length === 0) {
      const symbolRepo = this.dataSource.getRepository(EtfSymbolEntity);
      const tracked = await symbolRepo.find({
        where: { tracked: true } as never,
        select: ['tsCode'] as never,
      });
      etfCodes = tracked.map((r) => r.tsCode);
    }
    if (etfCodes.length === 0) return { success: 0, errors };

    const total = etfCodes.length;
    for (let i = 0; i < etfCodes.length; i++) {
      const tsCode = etfCodes[i];
      try {
        const count = await this.syncOneEtf(
          tsCode,
          startDate,
          endDate,
          amvRepo,
          syncMode ?? 'incremental',
        );
        totalWritten += count;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`[etf-amv] ${tsCode} 异常: ${msg}`);
        errors.push({ apiName: 'etf_amv', message: `${tsCode}: ${msg}` });
      }
      onProgress?.({
        phase: '同步 ETF AMV',
        percent: ((i + 1) / total) * 100,
        message: `${tsCode} (${i + 1}/${total})`,
      });
    }

    this.logger.log(`[etf-amv] 完成：${etfCodes.length} 只 ETF，落库 ${totalWritten} 行`);
    return { success: totalWritten, errors };
  }

  private async syncOneEtf(
    tsCode: string,
    startDate: string,
    endDate: string,
    amvRepo: Repository<FundAmvDailyEntity>,
    syncMode: AmvSyncMode,
  ): Promise<number> {
    // 1. 获取成分股列表（从 etf_pcf 最新一条有成分股的记录）
    const pcfRepo = this.dataSource.getRepository(EtfPcfEntity);
    const pcfRows = await pcfRepo
      .createQueryBuilder('p')
      .select('p.conCode', 'conCode')
      .where('p.tsCode = :tsCode', { tsCode })
      .andWhere('p.tradeDate <= :endDate', { endDate })
      .andWhere("p.conCode != ''")
      .orderBy('p.tradeDate', 'DESC')
      .limit(500)
      .getRawMany<{ conCode: string }>();

    if (pcfRows.length === 0) {
      this.logger.warn(`[etf-amv] ${tsCode} 无 PCF 成分股数据，跳过`);
      return 0;
    }

    const conCodes = [...new Set(pcfRows.map((r) => r.conCode))];

    // 2. 获取 ETF 价格数据
    const dailyRepo = this.dataSource.getRepository(FundDailyEntity);
    const priceRows = await dailyRepo
      .createQueryBuilder('f')
      .select(['f.tradeDate', 'f.open', 'f.high', 'f.low', 'f.close'])
      .where('f.tsCode = :tsCode', { tsCode })
      .andWhere('f.tradeDate >= :startDate', { startDate })
      .andWhere('f.tradeDate <= :endDate', { endDate })
      .orderBy('f.tradeDate', 'ASC')
      .getMany();

    if (priceRows.length === 0) {
      return 0;
    }

    // 3. 聚合成分股成交额
    const amtMap = await aggregateAmount(
      this.dataSource,
      conCodes,
      startDate,
      endDate,
    );

    if (amtMap.size === 0) {
      this.logger.warn(`[etf-amv] ${tsCode} 成分股无成交额数据`);
    }

    // 4. 构建并落库 AMV 日线
    const amvRows = buildAmvDailyRows(
      priceRows.map((r) => ({
        tradeDate: r.tradeDate,
        open: r.open ? Number(r.open) : null,
        high: r.high ? Number(r.high) : null,
        low: r.low ? Number(r.low) : null,
        close: r.close ? Number(r.close) : null,
      })),
      amtMap,
      startDate,
      conCodes.length,
      tsCode,
      this.logger,
      'etf',
    );

    if (amvRows.length === 0) return 0;

    // persistAmvDaily 需要 AmvDailyEntityLike 接口；syncMode 决定增量跳过 vs 全量重写
    const written = await persistAmvDaily(
      amvRepo,
      tsCode,
      amvRows as AmvDailyRow[],
      syncMode,
      this.logger,
      'etf',
    );

    return written;
  }
}
