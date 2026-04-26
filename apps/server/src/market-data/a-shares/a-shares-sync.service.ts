import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AShareDailyMetricEntity } from '../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { asNullableString, asString, formatChinaDate } from './a-shares-format.util';
import { ASharesIndicatorService } from './a-shares-indicator.service';
import { DAILY_BASIC_FIELDS, DAILY_FIELDS, STOCK_BASIC_FIELDS } from './a-shares-sync.constants';
import { ASharesSyncEvent, ASharesSyncRange, ASharesSyncResult, SyncASharesDto } from './a-shares.types';
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
    let indicators = 0;

    if (!total) {
      return { ok: true, symbols, quotes, metrics, indicators, startDate: range.startDate, endDate: range.endDate };
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
      quotes += await this.syncDailyQuotesByTradeDate(tradeDate);

      emit({
        type: 'progress',
        phase: '同步每日指标',
        current: index,
        total,
        percent: this.calculateSyncPercent(index + 0.5, total),
        message: tradeDate,
      });
      metrics += await this.syncDailyMetricsByTradeDate(tradeDate);

      emit({
        type: 'progress',
        phase: '同步交易日',
        current: index + 1,
        total,
        percent: this.calculateSyncPercent(index + 1, total),
        message: `${tradeDate} 日线 ${quotes}，指标 ${metrics}`,
      });
    }

    emit({
      type: 'progress',
      phase: '计算技术指标',
      current: 0,
      total: 1,
      percent: 98,
      message: `${range.startDate} - ${range.endDate}`,
    });
    indicators = await this.indicatorService.recalculateIndicatorsForRange(range);

    return { ok: true, symbols, quotes, metrics, indicators, startDate: range.startDate, endDate: range.endDate };
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

  private async syncDailyQuotesByTradeDate(tradeDate: string): Promise<number> {
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
    return entities.length;
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
