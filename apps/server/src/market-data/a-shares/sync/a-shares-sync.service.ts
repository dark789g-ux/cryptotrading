import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdjFactorEntity } from '../../../entities/raw/adj-factor.entity';
import { DailyBasicEntity } from '../../../entities/raw/daily-basic.entity';
import { DailyQuoteEntity } from '../../../entities/raw/daily-quote.entity';
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
  createStageFailedItem,
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
  private readonly logger = new Logger(ASharesSyncService.name);

  constructor(
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectRepository(DailyQuoteEntity)
    private readonly quoteRepo: Repository<DailyQuoteEntity>,
    @InjectRepository(DailyBasicEntity)
    private readonly metricRepo: Repository<DailyBasicEntity>,
    @InjectRepository(AdjFactorEntity)
    private readonly adjFactorRepo: Repository<AdjFactorEntity>,
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
    let completedDates = 0;
    const changedRanges = new Map<string, string>();
    const latestAdjFactorChanged = new Set<string>();
    const failedItems: ASharesSyncFailedItem[] = [];

    if (!total) {
      this.logger.warn(
        `resolveOpenTradeDates 在 ${range.startDate}-${range.endDate} 范围内未返回任何开市日，` +
        `请确认日期参数是否被前端错误转换（曾因 UTC 漂移导致整段日期推前 1 天）`,
      );
      failedItems.push({
        apiName: 'no_open_trade_dates',
        message: `${range.startDate} - ${range.endDate} 范围内无开市日，未执行任何数据同步`,
      });
      return createResult('partial', symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
    }

    await Promise.all(tradeDates.map(async (tradeDate) => {
      let syncedDatasetsForDate = 0;
      let skippedDatasetsForDate = 0;

      try {
        if (await shouldSyncDataset(this.quoteRepo, syncMode, 'daily', tradeDate)) {
          const result = await syncDailyQuotesByTradeDate(this.fetcherDeps, tradeDate);
          quotes += result.count;
          syncedDatasetsForDate++;
          mergeChangedDates(changedRanges, result.tsCodes, tradeDate);
          if (result.count === 0) {
            failedItems.push({
              tradeDate,
              apiName: 'daily_empty',
              message: 'TuShare daily 返回 0 行，可能日期参数错误或当日数据未发布',
            });
          }
        } else {
          skippedDatasets++;
          skippedDatasetsForDate++;
        }
      } catch (err: unknown) {
        failedItems.push(createFailedItem('daily', tradeDate, err));
      }

      try {
        if (await shouldSyncDataset(this.quoteRepo, syncMode, 'daily_basic', tradeDate)) {
          const count = await syncDailyMetricsByTradeDate(this.fetcherDeps, tradeDate);
          metrics += count;
          syncedDatasetsForDate++;
          if (count === 0) {
            failedItems.push({
              tradeDate,
              apiName: 'daily_basic_empty',
              message: 'TuShare daily_basic 返回 0 行，可能日期参数错误或当日数据未发布',
            });
          }
        } else {
          skippedDatasets++;
          skippedDatasetsForDate++;
        }
      } catch (err: unknown) {
        failedItems.push(createFailedItem('daily_basic', tradeDate, err));
      }

      try {
        if (await shouldSyncDataset(this.quoteRepo, syncMode, 'adj_factor', tradeDate)) {
          const result = await syncAdjFactorsByTradeDate(this.fetcherDeps, tradeDate);
          adjFactors += result.count;
          syncedDatasetsForDate++;
          mergeChangedDates(changedRanges, result.tsCodes, tradeDate);
          result.latestChangedTsCodes.forEach((tsCode) => latestAdjFactorChanged.add(tsCode));
          if (result.count === 0) {
            failedItems.push({
              tradeDate,
              apiName: 'adj_factor_empty',
              message: 'TuShare adj_factor 返回 0 行，可能日期参数错误或当日数据未发布',
            });
          }
        } else {
          skippedDatasets++;
          skippedDatasetsForDate++;
        }
      } catch (err: unknown) {
        failedItems.push(createFailedItem('adj_factor', tradeDate, err));
      }

      if (syncedDatasetsForDate === 0 && skippedDatasetsForDate === 3) skippedDates++;

      completedDates++;
      emit({
        type: 'progress',
        phase: '同步交易日',
        current: completedDates,
        total,
        percent: calculateSyncPercent(completedDates, total),
        message: `${tradeDate} 日线 ${quotes}，指标 ${metrics}，复权因子 ${adjFactors}，跳过 ${skippedDatasets}`,
      });
    }));

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
    try {
      await markDirtyRanges(this.dirtyRangeDeps, changedRanges, latestAdjFactorChanged);
    } catch (err: unknown) {
      failedItems.push(createStageFailedItem('mark_dirty_ranges', err));
    }

    if (changedRanges.size > 0) {
      emit({
        type: 'progress',
        phase: '增量计算前复权',
        current: 0,
        total: changedRanges.size,
        percent: 96,
        message: `${changedRanges.size} 只股票`,
      });
      try {
        await recalculateDirtyQfqQuotes(this.dirtyRangeDeps, [...changedRanges.keys()], (current, total, tsCode) => {
          emit({
            type: 'progress',
            phase: '增量计算前复权',
            current,
            total,
            percent: 96 + (current / total) * 2,
            message: tsCode,
          });
        });
      } catch (err: unknown) {
        failedItems.push(createStageFailedItem('qfq_recalculate', err));
      }

      emit({
        type: 'progress',
        phase: '增量计算技术指标',
        current: 0,
        total: changedRanges.size,
        percent: 98,
        message: `${changedRanges.size} 只股票`,
      });
      try {
        indicators = await this.indicatorService.recalculateDirtyIndicatorsForSymbols(
          [...changedRanges.keys()],
          (current, total, tsCode) => {
            emit({
              type: 'progress',
              phase: '增量计算技术指标',
              current,
              total,
              percent: 98 + (current / total) * 2,
              message: tsCode,
            });
          },
        );
      } catch (err: unknown) {
        failedItems.push(createStageFailedItem('indicator_recalculate', err));
      }
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
