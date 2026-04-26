import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AShareAdjFactorEntity } from '../../entities/a-share/a-share-adj-factor.entity';
import { AShareDailyMetricEntity } from '../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { asNullableString, asString, formatChinaDate } from './a-shares-format.util';
import { ASharesIndicatorService } from './a-shares-indicator.service';
import { ADJ_FACTOR_FIELDS, DAILY_BASIC_FIELDS, DAILY_FIELDS, STOCK_BASIC_FIELDS } from './a-shares-sync.constants';
import {
  ASharesSyncEvent,
  ASharesSyncFailedItem,
  ASharesSyncRange,
  ASharesSyncResult,
  ASharesSyncStatus,
  SyncASharesDto,
} from './a-shares.types';
import { TushareClientService } from './tushare-client.service';

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
    private readonly tushareClient: TushareClientService,
    private readonly indicatorService: ASharesIndicatorService,
  ) {}

  async syncWithProgress(
    dto: SyncASharesDto,
    emit: (event: ASharesSyncEvent) => void = () => undefined,
  ): Promise<ASharesSyncResult> {
    emit({ type: 'start' });
    emit({ type: 'progress', phase: '同步股票列表', current: 0, total: 1, percent: 0 });
    const symbols = await this.syncSymbols();

    const range = await this.resolveSyncRange(dto);
    emit({
      type: 'progress',
      phase: '获取交易日历',
      current: 0,
      total: 1,
      percent: 5,
      message: `${range.startDate} - ${range.endDate}`,
    });
    const tradeDates = await this.resolveOpenTradeDates(range);
    const total = tradeDates.length;
    let quotes = 0;
    let metrics = 0;
    let adjFactors = 0;
    let indicators = 0;
    const changedTsCodes = new Set<string>();
    const failedItems: ASharesSyncFailedItem[] = [];

    if (!total) {
      return this.createResult('done', symbols, quotes, metrics, adjFactors, indicators, failedItems, range);
    }

    for (let index = 0; index < tradeDates.length; index++) {
      const tradeDate = tradeDates[index];
      emit({
        type: 'progress',
        phase: '同步日线行情',
        current: index,
        total,
        percent: this.calculateSyncPercent(index, total),
        message: tradeDate,
      });
      try {
        const result = await this.syncDailyQuotesByTradeDate(tradeDate);
        quotes += result.count;
        result.tsCodes.forEach((tsCode) => changedTsCodes.add(tsCode));
      } catch (err: unknown) {
        failedItems.push(this.createFailedItem('daily', tradeDate, err));
      }

      emit({
        type: 'progress',
        phase: '同步每日指标',
        current: index,
        total,
        percent: this.calculateSyncPercent(index + 0.5, total),
        message: tradeDate,
      });
      try {
        metrics += await this.syncDailyMetricsByTradeDate(tradeDate);
      } catch (err: unknown) {
        failedItems.push(this.createFailedItem('daily_basic', tradeDate, err));
      }

      emit({
        type: 'progress',
        phase: '同步复权因子',
        current: index,
        total,
        percent: this.calculateSyncPercent(index + 0.75, total),
        message: tradeDate,
      });
      try {
        const result = await this.syncAdjFactorsByTradeDate(tradeDate);
        adjFactors += result.count;
        result.tsCodes.forEach((tsCode) => changedTsCodes.add(tsCode));
      } catch (err: unknown) {
        failedItems.push(this.createFailedItem('adj_factor', tradeDate, err));
      }

      emit({
        type: 'progress',
        phase: '同步交易日',
        current: index + 1,
        total,
        percent: this.calculateSyncPercent(index + 1, total),
        message: `${tradeDate} 日线 ${quotes}，指标 ${metrics}，复权因子 ${adjFactors}`,
      });
    }

    if (quotes <= 0 && failedItems.length > 0) {
      failedItems.push({
        apiName: 'technical_indicators',
        message: '没有成功写入日线行情，已跳过技术指标计算',
      });
      return this.createResult('error', symbols, quotes, metrics, adjFactors, indicators, failedItems, range);
    }

    emit({
      type: 'progress',
      phase: '计算前复权行情',
      current: 0,
      total: changedTsCodes.size,
      percent: 96,
      message: `${changedTsCodes.size} 只股票`,
    });
    await this.recalculateQfqQuotes([...changedTsCodes]);

    emit({
      type: 'progress',
      phase: '计算技术指标',
      current: 0,
      total: 1,
      percent: 98,
      message: `${range.startDate} - ${range.endDate}`,
    });
    indicators = await this.indicatorService.recalculateIndicatorsForSymbols([...changedTsCodes]);

    const status: ASharesSyncStatus = failedItems.length > 0 ? 'partial' : 'done';
    return this.createResult(status, symbols, quotes, metrics, adjFactors, indicators, failedItems, range);
  }

  private async syncSymbols(): Promise<number> {
    const rows = await this.tushareClient.query('stock_basic', { exchange: '', list_status: 'L' }, STOCK_BASIC_FIELDS);
    const entities = rows.map((row) =>
      this.symbolRepo.create({
        tsCode: asString(row.ts_code),
        symbol: asString(row.symbol),
        name: asString(row.name),
        area: asNullableString(row.area),
        industry: asNullableString(row.industry),
        market: asNullableString(row.market),
        exchange: asNullableString(row.exchange),
        listStatus: asNullableString(row.list_status),
        listDate: asNullableString(row.list_date),
        delistDate: asNullableString(row.delist_date),
        isHs: asNullableString(row.is_hs),
      }),
    );
    await this.upsertInChunks(this.symbolRepo, entities, ['tsCode']);
    return entities.length;
  }

  private async syncDailyQuotesByTradeDate(tradeDate: string): Promise<{ count: number; tsCodes: string[] }> {
    const rows = await this.tushareClient.query(
      'daily',
      { trade_date: tradeDate },
      DAILY_FIELDS,
    );
    const entities = rows.map((row) =>
      this.quoteRepo.create({
        tsCode: asString(row.ts_code),
        tradeDate: asString(row.trade_date),
        open: asNullableString(row.open),
        high: asNullableString(row.high),
        low: asNullableString(row.low),
        close: asNullableString(row.close),
        preClose: asNullableString(row.pre_close),
        change: asNullableString(row.change),
        pctChg: asNullableString(row.pct_chg),
        vol: asNullableString(row.vol),
        amount: asNullableString(row.amount),
      }),
    );
    await this.upsertInChunks(this.quoteRepo, entities, ['tsCode', 'tradeDate']);
    return { count: entities.length, tsCodes: rows.map((row) => asString(row.ts_code)).filter(Boolean) };
  }

  private async syncDailyMetricsByTradeDate(tradeDate: string): Promise<number> {
    const rows = await this.tushareClient.query(
      'daily_basic',
      { trade_date: tradeDate },
      DAILY_BASIC_FIELDS,
    );
    const entities = rows.map((row) =>
      this.metricRepo.create({
        tsCode: asString(row.ts_code),
        tradeDate: asString(row.trade_date),
        turnoverRate: asNullableString(row.turnover_rate),
        volumeRatio: asNullableString(row.volume_ratio),
        pe: asNullableString(row.pe),
        pb: asNullableString(row.pb),
        totalMv: asNullableString(row.total_mv),
        circMv: asNullableString(row.circ_mv),
      }),
    );
    await this.upsertInChunks(this.metricRepo, entities, ['tsCode', 'tradeDate']);
    return entities.length;
  }

  private async syncAdjFactorsByTradeDate(tradeDate: string): Promise<{ count: number; tsCodes: string[] }> {
    const rows = await this.tushareClient.query(
      'adj_factor',
      { trade_date: tradeDate },
      ADJ_FACTOR_FIELDS,
    );
    const entities = rows.map((row) =>
      this.adjFactorRepo.create({
        tsCode: asString(row.ts_code),
        tradeDate: asString(row.trade_date),
        adjFactor: asNullableString(row.adj_factor),
      }),
    );
    await this.upsertInChunks(this.adjFactorRepo, entities, ['tsCode', 'tradeDate']);
    return { count: entities.length, tsCodes: rows.map((row) => asString(row.ts_code)).filter(Boolean) };
  }

  private async recalculateQfqQuotes(tsCodes: string[]): Promise<void> {
    for (const tsCode of tsCodes) {
      await this.recalculateQfqQuotesForSymbol(tsCode);
    }
  }

  private async recalculateQfqQuotesForSymbol(tsCode: string): Promise<void> {
    await this.quoteRepo.query(`
      WITH adjusted AS (
        SELECT
          q.id,
          q.trade_date,
          CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.open * f.adj_factor / latest.adj_factor END AS qfq_open,
          CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.high * f.adj_factor / latest.adj_factor END AS qfq_high,
          CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.low * f.adj_factor / latest.adj_factor END AS qfq_low,
          CASE WHEN latest.adj_factor IS NULL OR latest.adj_factor = 0 OR f.adj_factor IS NULL THEN NULL ELSE q.close * f.adj_factor / latest.adj_factor END AS qfq_close
        FROM a_share_daily_quotes q
        LEFT JOIN a_share_adj_factors f ON f.ts_code = q.ts_code AND f.trade_date = q.trade_date
        LEFT JOIN LATERAL (
          SELECT lf.adj_factor
          FROM a_share_adj_factors lf
          WHERE lf.ts_code = q.ts_code
            AND lf.adj_factor IS NOT NULL
          ORDER BY lf.trade_date DESC
          LIMIT 1
        ) latest ON true
        WHERE q.ts_code = $1
      ),
      with_prev AS (
        SELECT
          id,
          qfq_open,
          qfq_high,
          qfq_low,
          qfq_close,
          LAG(qfq_close) OVER (ORDER BY trade_date ASC) AS qfq_pre_close
        FROM adjusted
      )
      UPDATE a_share_daily_quotes AS target
      SET
        qfq_open = with_prev.qfq_open,
        qfq_high = with_prev.qfq_high,
        qfq_low = with_prev.qfq_low,
        qfq_close = with_prev.qfq_close,
        qfq_pre_close = with_prev.qfq_pre_close,
        qfq_change = CASE
          WHEN with_prev.qfq_close IS NULL OR with_prev.qfq_pre_close IS NULL THEN NULL
          ELSE with_prev.qfq_close - with_prev.qfq_pre_close
        END,
        qfq_pct_chg = CASE
          WHEN with_prev.qfq_close IS NULL OR with_prev.qfq_pre_close IS NULL OR with_prev.qfq_pre_close = 0 THEN NULL
          ELSE (with_prev.qfq_close - with_prev.qfq_pre_close) / with_prev.qfq_pre_close * 100
        END
      FROM with_prev
      WHERE target.id = with_prev.id
    `, [tsCode]);
  }

  private async resolveOpenTradeDates(range: ASharesSyncRange): Promise<string[]> {
    const rows = await this.tushareClient.query(
      'trade_cal',
      { exchange: 'SSE', start_date: range.startDate, end_date: range.endDate, is_open: 1 },
      'cal_date,is_open',
    );
    return rows
      .map((row) => asString(row.cal_date))
      .filter((date) => date.length === 8)
      .sort();
  }

  private calculateSyncPercent(current: number, total: number): number {
    if (total <= 0) return 100;
    return Math.round((10 + (current / total) * 90) * 10) / 10;
  }

  private createFailedItem(apiName: string, tradeDate: string, err: unknown): ASharesSyncFailedItem {
    return {
      tradeDate,
      apiName,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  private createResult(
    status: ASharesSyncStatus,
    symbols: number,
    quotes: number,
    metrics: number,
    adjFactors: number,
    indicators: number,
    failedItems: ASharesSyncFailedItem[],
    range: ASharesSyncRange,
  ): ASharesSyncResult {
    return {
      ok: status !== 'error',
      status,
      symbols,
      quotes,
      metrics,
      adjFactors,
      indicators,
      failedCount: failedItems.length,
      failedItems,
      startDate: range.startDate,
      endDate: range.endDate,
    };
  }

  private async resolveSyncRange(dto: SyncASharesDto): Promise<ASharesSyncRange> {
    if (dto.tradeDate) return { startDate: dto.tradeDate, endDate: dto.tradeDate };
    if (dto.startDate && dto.endDate) return { startDate: dto.startDate, endDate: dto.endDate };

    const endDate = formatChinaDate(new Date());
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 14);
    const startDate = formatChinaDate(start);
    const rows = await this.tushareClient.query(
      'trade_cal',
      { exchange: 'SSE', start_date: startDate, end_date: endDate, is_open: 1 },
      'cal_date,is_open',
    );
    const openDates = rows
      .map((row) => asString(row.cal_date))
      .filter((date) => date.length === 8)
      .sort();
    const latest = openDates.length ? openDates[openDates.length - 1] : undefined;
    const tradeDate = latest ?? endDate;
    return { startDate: tradeDate, endDate: tradeDate };
  }

  private async upsertInChunks<Entity extends object>(
    repo: Repository<Entity>,
    entities: Entity[],
    conflictPaths: string[],
  ): Promise<void> {
    const chunkSize = 1000;
    for (let index = 0; index < entities.length; index += chunkSize) {
      await repo.upsert(entities.slice(index, index + chunkSize), conflictPaths);
    }
  }
}
