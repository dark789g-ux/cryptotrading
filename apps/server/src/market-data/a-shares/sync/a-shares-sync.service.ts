import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AShareAdjFactorEntity } from '../../../entities/a-share/a-share-adj-factor.entity';
import { AShareDailyMetricEntity } from '../../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../../entities/a-share/a-share-symbol.entity';
import { AShareSyncStateEntity } from '../../../entities/a-share/a-share-sync-state.entity';
import { ASharesIndicatorService } from '../services/a-shares-indicator.service';
import { shouldSyncDataset } from './a-shares-sync-completeness';
import { markDirtyRanges, mergeChangedDates, recalculateDirtyQfqQuotes } from './a-shares-sync-dirty-ranges';
import {
  syncAdjFactorsByTradeDate,
  syncDailyMetricsByTradeDate,
  syncDailyQuotesByTradeDate,
  syncSymbols,
} from './a-shares-sync-fetchers';
import {
  calculateSyncPercent,
  createFailedItem,
  createResult,
  normalizeSyncMode,
  resolveOpenTradeDates,
  resolveSyncRange,
} from './a-shares-sync-utils';
import {
  ASharesSyncEvent,
  ASharesSyncFailedItem,
  ASharesSyncResult,
  ASharesSyncStatus,
  SyncASharesDto,
} from '../a-shares.types';
import { TushareClientService } from '../services/tushare-client.service';

@Injectable()
export class ASharesSyncService {
  constructor(
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectRepository(AShareDailyQuoteEntity)
    private readonly quoteRepo: Repository<AShareDailyQuoteEntity>,
    @InjectRepository(AShareDailyMetricEntity)
    private readonly metricRepo: Repository<AShareDailyMetricEntity>,
    @InjectRepository(AShareAdjFactorEntity)
    private readonly adjFactorRepo: Repository<AShareAdjFactorEntity>,
    @InjectRepository(AShareSyncStateEntity)
    private readonly syncStateRepo: Repository<AShareSyncStateEntity>,
    private readonly tushareClient: TushareClientService,
    private readonly indicatorService: ASharesIndicatorService,
  ) {}

  async syncWithProgress(
    dto: SyncASharesDto,
    emit: (event: ASharesSyncEvent) => void = () => undefined,
  ): Promise<ASharesSyncResult> {
    const syncMode = normalizeSyncMode(dto.syncMode);
    emit({ type: 'start' });
    emit({ type: 'progress', phase: '同步股票列表', current: 0, total: 1, percent: 0 });
    const symbols = await syncSymbols(this.fetcherDeps);

    const range = await resolveSyncRange(this.tushareClient, dto);
    emit({
      type: 'progress',
      phase: '获取交易日历',
      current: 0,
      total: 1,
      percent: 5,
      message: `${range.startDate} - ${range.endDate}`,
    });
    const tradeDates = await resolveOpenTradeDates(this.tushareClient, range);
    const total = tradeDates.length;
    let quotes = 0;
    let metrics = 0;
    let adjFactors = 0;
    let indicators = 0;
    let skippedDates = 0;
    let skippedDatasets = 0;
    const changedRanges = new Map<string, string>();
    const latestAdjFactorChanged = new Set<string>();
    const failedItems: ASharesSyncFailedItem[] = [];

    if (!total) {
      return createResult('done', symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
    }

    for (let index = 0; index < tradeDates.length; index++) {
      const tradeDate = tradeDates[index];
      let syncedDatasetsForDate = 0;
      let skippedDatasetsForDate = 0;

      emit({
        type: 'progress',
        phase: '同步日线行情',
        current: index,
        total,
        percent: calculateSyncPercent(index, total),
        message: tradeDate,
      });
      try {
        if (await shouldSyncDataset(this.quoteRepo, syncMode, 'daily', tradeDate)) {
          const result = await syncDailyQuotesByTradeDate(this.fetcherDeps, tradeDate);
          quotes += result.count;
          syncedDatasetsForDate++;
          mergeChangedDates(changedRanges, result.tsCodes, tradeDate);
        } else {
          skippedDatasets++;
          skippedDatasetsForDate++;
        }
      } catch (err: unknown) {
        failedItems.push(createFailedItem('daily', tradeDate, err));
      }

      emit({
        type: 'progress',
        phase: '同步每日指标',
        current: index,
        total,
        percent: calculateSyncPercent(index + 0.5, total),
        message: tradeDate,
      });
      try {
        if (await shouldSyncDataset(this.quoteRepo, syncMode, 'daily_basic', tradeDate)) {
          metrics += await syncDailyMetricsByTradeDate(this.fetcherDeps, tradeDate);
          syncedDatasetsForDate++;
        } else {
          skippedDatasets++;
          skippedDatasetsForDate++;
        }
      } catch (err: unknown) {
        failedItems.push(createFailedItem('daily_basic', tradeDate, err));
      }

      emit({
        type: 'progress',
        phase: '同步复权因子',
        current: index,
        total,
        percent: calculateSyncPercent(index + 0.75, total),
        message: tradeDate,
      });
      try {
        if (await shouldSyncDataset(this.quoteRepo, syncMode, 'adj_factor', tradeDate)) {
          const result = await syncAdjFactorsByTradeDate(this.fetcherDeps, tradeDate);
          adjFactors += result.count;
          syncedDatasetsForDate++;
          mergeChangedDates(changedRanges, result.tsCodes, tradeDate);
          result.latestChangedTsCodes.forEach((tsCode) => latestAdjFactorChanged.add(tsCode));
        } else {
          skippedDatasets++;
          skippedDatasetsForDate++;
        }
      } catch (err: unknown) {
        failedItems.push(createFailedItem('adj_factor', tradeDate, err));
      }

      if (syncedDatasetsForDate === 0 && skippedDatasetsForDate === 3) skippedDates++;

      emit({
        type: 'progress',
        phase: '同步交易日',
        current: index + 1,
        total,
        percent: calculateSyncPercent(index + 1, total),
        message: `${tradeDate} 日线 ${quotes}，指标 ${metrics}，复权因子 ${adjFactors}，跳过 ${skippedDatasets}`,
      });
    }

    if (quotes + metrics + adjFactors <= 0 && failedItems.length > 0 && skippedDatasets < total * 3) {
      failedItems.push({
        apiName: 'technical_indicators',
        message: '没有成功写入日线行情，已跳过技术指标计算',
      });
      return createResult('error', symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
    }

    emit({
      type: 'progress',
      phase: '标记脏区间',
      current: 0,
      total: changedRanges.size,
      percent: 95,
      message: `${changedRanges.size} 只股票`,
    });
    await markDirtyRanges(this.dirtyRangeDeps, changedRanges, latestAdjFactorChanged);

    if (changedRanges.size > 0) {
      emit({
        type: 'progress',
        phase: '增量计算前复权',
        current: 0,
        total: changedRanges.size,
        percent: 96,
        message: `${changedRanges.size} 只股票`,
      });
      await recalculateDirtyQfqQuotes(this.dirtyRangeDeps, [...changedRanges.keys()]);
      emit({
        type: 'progress',
        phase: '增量计算技术指标',
        current: 0,
        total: 1,
        percent: 98,
        message: `${range.startDate} - ${range.endDate}`,
      });
      indicators = await this.indicatorService.recalculateDirtyIndicatorsForSymbols([...changedRanges.keys()]);
    }

    const status: ASharesSyncStatus = failedItems.length > 0 ? 'partial' : 'done';
    return createResult(status, symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
  }

  private get fetcherDeps() {
    return {
      symbolRepo: this.symbolRepo,
      quoteRepo: this.quoteRepo,
      metricRepo: this.metricRepo,
      adjFactorRepo: this.adjFactorRepo,
      tushareClient: this.tushareClient,
    };
  }

  private get dirtyRangeDeps() {
    return {
      quoteRepo: this.quoteRepo,
      syncStateRepo: this.syncStateRepo,
    };
  }
}
