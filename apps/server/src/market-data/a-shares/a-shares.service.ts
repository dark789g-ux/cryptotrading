import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { AShareDailyMetricEntity } from '../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { TushareClientService, TushareRow } from './tushare-client.service';

type SortOrder = 'ascend' | 'descend' | null;

interface QueryCondition {
  field: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value: number;
}

export interface QueryASharesDto {
  page?: number;
  pageSize?: number;
  q?: string;
  market?: string | null;
  industry?: string | null;
  sort?: { field?: string; order?: SortOrder; asc?: boolean };
  conditions?: QueryCondition[];
}

export interface SyncASharesDto {
  tradeDate?: string;
  startDate?: string;
  endDate?: string;
}

export interface ASharesSyncResult {
  ok: true;
  symbols: number;
  quotes: number;
  metrics: number;
  startDate: string;
  endDate: string;
}

export interface ASharesSyncEvent extends Partial<ASharesSyncResult> {
  type: 'start' | 'progress' | 'done' | 'error';
  phase?: string;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

const STOCK_BASIC_FIELDS = [
  'ts_code',
  'symbol',
  'name',
  'area',
  'industry',
  'market',
  'exchange',
  'list_status',
  'list_date',
  'delist_date',
  'is_hs',
].join(',');

const DAILY_FIELDS = [
  'ts_code',
  'trade_date',
  'open',
  'high',
  'low',
  'close',
  'pre_close',
  'change',
  'pct_chg',
  'vol',
  'amount',
].join(',');

const DAILY_BASIC_FIELDS = [
  'ts_code',
  'trade_date',
  'turnover_rate',
  'volume_ratio',
  'pe',
  'pb',
  'total_mv',
  'circ_mv',
].join(',');

const OP_MAP: Record<QueryCondition['op'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

const CONDITION_COL_MAP: Record<string, string> = {
  close: 'q.close',
  pctChg: 'q.pct_chg',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  volumeRatio: 'm.volume_ratio',
  pe: 'm.pe',
  pb: 'm.pb',
};

const SORT_COL_MAP: Record<string, string> = {
  tsCode: 's.ts_code',
  symbol: 's.symbol',
  name: 's.name',
  market: 's.market',
  industry: 's.industry',
  close: 'q.close',
  pctChg: 'q.pct_chg',
  amount: 'q.amount',
  turnoverRate: 'm.turnover_rate',
  pe: 'm.pe',
  pb: 'm.pb',
  tradeDate: 'q.trade_date',
};

@Injectable()
export class ASharesService {
  private isSyncing = false;

  constructor(
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectRepository(AShareDailyQuoteEntity)
    private readonly quoteRepo: Repository<AShareDailyQuoteEntity>,
    @InjectRepository(AShareDailyMetricEntity)
    private readonly metricRepo: Repository<AShareDailyMetricEntity>,
    private readonly dataSource: DataSource,
    private readonly tushareClient: TushareClientService,
  ) {}

  async sync(dto: SyncASharesDto = {}): Promise<ASharesSyncResult> {
    return this.syncWithProgress(dto);
  }

  startSync(dto: SyncASharesDto = {}): Subject<ASharesSyncEvent> {
    const subject = new Subject<ASharesSyncEvent>();
    if (this.isSyncing) {
      setTimeout(() => {
        subject.next({ type: 'error', message: 'A 股同步任务正在运行中，请稍后再试' });
        subject.complete();
      }, 0);
      return subject;
    }

    this.isSyncing = true;
    setTimeout(() => {
      this.syncWithProgress(dto, (event) => subject.next(event))
        .then((result) => {
          subject.next({ type: 'done', message: 'A 股数据同步完成', ...result });
          subject.complete();
        })
        .catch((err: unknown) => {
          subject.next({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          subject.complete();
        })
        .finally(() => {
          this.isSyncing = false;
        });
    }, 0);
    return subject;
  }

  async getSummary() {
    const rows = await this.dataSource.query<Array<Record<string, string | null>>>(`
      WITH latest AS (
        SELECT MAX(trade_date) AS trade_date FROM a_share_daily_quotes
      )
      SELECT
        (SELECT COUNT(*) FROM a_share_symbols WHERE list_status = 'L') AS "totalSymbols",
        latest.trade_date AS "latestTradeDate",
        COUNT(q.ts_code) FILTER (WHERE q.pct_chg::numeric > 0) AS "upCount",
        COUNT(q.ts_code) FILTER (WHERE q.pct_chg::numeric < 0) AS "downCount",
        COUNT(q.ts_code) AS "quotedCount"
      FROM latest
      LEFT JOIN a_share_daily_quotes q ON q.trade_date = latest.trade_date
      GROUP BY latest.trade_date
    `);
    return rows[0] ?? {
      totalSymbols: '0',
      latestTradeDate: null,
      upCount: '0',
      downCount: '0',
      quotedCount: '0',
    };
  }

  async query(dto: QueryASharesDto) {
    const page = Math.max(1, Number(dto.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(dto.pageSize ?? 10)));
    const params: Array<string | number> = [];
    let paramIndex = 1;

    let sql = `
      WITH latest AS (
        SELECT ts_code, MAX(trade_date) AS trade_date
        FROM a_share_daily_quotes
        GROUP BY ts_code
      )
      SELECT
        s.ts_code AS "tsCode",
        s.symbol,
        s.name,
        s.market,
        s.industry,
        q.close,
        q.pct_chg AS "pctChg",
        q.amount,
        m.turnover_rate AS "turnoverRate",
        m.volume_ratio AS "volumeRatio",
        m.pe,
        m.pb,
        q.trade_date AS "tradeDate"
      FROM a_share_symbols s
      LEFT JOIN latest l ON l.ts_code = s.ts_code
      LEFT JOIN a_share_daily_quotes q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
      LEFT JOIN a_share_daily_metrics m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
      WHERE s.list_status = 'L'
    `;

    if (dto.q?.trim()) {
      sql += ` AND (s.ts_code ILIKE $${paramIndex} OR s.symbol ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`;
      params.push(`%${dto.q.trim()}%`);
      paramIndex++;
    }

    if (dto.market) {
      sql += ` AND s.market = $${paramIndex}`;
      params.push(dto.market);
      paramIndex++;
    }

    if (dto.industry) {
      sql += ` AND s.industry = $${paramIndex}`;
      params.push(dto.industry);
      paramIndex++;
    }

    for (const condition of (dto.conditions ?? []).slice(0, 10)) {
      const column = CONDITION_COL_MAP[condition.field];
      const op = OP_MAP[condition.op];
      if (!column || !op) continue;
      sql += ` AND ${column} ${op} $${paramIndex}`;
      params.push(condition.value);
      paramIndex++;
    }

    const countRows = await this.dataSource.query<Array<{ count: string }>>(`SELECT COUNT(*) FROM (${sql}) sub`, params);
    const total = Number(countRows[0]?.count ?? 0);
    const sortField = dto.sort?.field ?? 'tsCode';
    const sortCol = SORT_COL_MAP[sortField] ?? 's.ts_code';
    const sortAsc = dto.sort?.order ? dto.sort.order !== 'descend' : dto.sort?.asc !== false;

    sql += ` ORDER BY ${sortCol} ${sortAsc ? 'ASC' : 'DESC'} NULLS LAST`;
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, (page - 1) * pageSize);

    const rows = await this.dataSource.query<Array<Record<string, string | null>>>(sql, params);
    return { rows, total, page, pageSize };
  }

  async getFilterOptions() {
    const markets = await this.symbolRepo
      .createQueryBuilder('s')
      .select('DISTINCT s.market', 'value')
      .where('s.market IS NOT NULL')
      .andWhere("s.market <> ''")
      .orderBy('s.market')
      .getRawMany<{ value: string }>();
    const industries = await this.symbolRepo
      .createQueryBuilder('s')
      .select('DISTINCT s.industry', 'value')
      .where('s.industry IS NOT NULL')
      .andWhere("s.industry <> ''")
      .orderBy('s.industry')
      .getRawMany<{ value: string }>();
    return { markets, industries };
  }

  private async syncSymbols(): Promise<number> {
    const rows = await this.tushareClient.query('stock_basic', { exchange: '', list_status: 'L' }, STOCK_BASIC_FIELDS);
    const entities = rows.map((row) =>
      this.symbolRepo.create({
        tsCode: this.asString(row.ts_code),
        symbol: this.asString(row.symbol),
        name: this.asString(row.name),
        area: this.asNullableString(row.area),
        industry: this.asNullableString(row.industry),
        market: this.asNullableString(row.market),
        exchange: this.asNullableString(row.exchange),
        listStatus: this.asNullableString(row.list_status),
        listDate: this.asNullableString(row.list_date),
        delistDate: this.asNullableString(row.delist_date),
        isHs: this.asNullableString(row.is_hs),
      }),
    );
    await this.upsertInChunks(this.symbolRepo, entities, ['tsCode']);
    return entities.length;
  }

  private async syncWithProgress(
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

    if (!total) {
      return { ok: true, symbols, quotes, metrics, startDate: range.startDate, endDate: range.endDate };
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

    return { ok: true, symbols, quotes, metrics, startDate: range.startDate, endDate: range.endDate };
  }

  private async syncDailyQuotesByTradeDate(tradeDate: string): Promise<number> {
    const rows = await this.tushareClient.query(
      'daily',
      { trade_date: tradeDate },
      DAILY_FIELDS,
    );
    const entities = rows.map((row) =>
      this.quoteRepo.create({
        tsCode: this.asString(row.ts_code),
        tradeDate: this.asString(row.trade_date),
        open: this.asNullableString(row.open),
        high: this.asNullableString(row.high),
        low: this.asNullableString(row.low),
        close: this.asNullableString(row.close),
        preClose: this.asNullableString(row.pre_close),
        change: this.asNullableString(row.change),
        pctChg: this.asNullableString(row.pct_chg),
        vol: this.asNullableString(row.vol),
        amount: this.asNullableString(row.amount),
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
        tsCode: this.asString(row.ts_code),
        tradeDate: this.asString(row.trade_date),
        turnoverRate: this.asNullableString(row.turnover_rate),
        volumeRatio: this.asNullableString(row.volume_ratio),
        pe: this.asNullableString(row.pe),
        pb: this.asNullableString(row.pb),
        totalMv: this.asNullableString(row.total_mv),
        circMv: this.asNullableString(row.circ_mv),
      }),
    );
    await this.upsertInChunks(this.metricRepo, entities, ['tsCode', 'tradeDate']);
    return entities.length;
  }

  private async resolveOpenTradeDates(range: { startDate: string; endDate: string }): Promise<string[]> {
    const rows = await this.tushareClient.query(
      'trade_cal',
      { exchange: 'SSE', start_date: range.startDate, end_date: range.endDate, is_open: 1 },
      'cal_date,is_open',
    );
    return rows
      .map((row) => this.asString(row.cal_date))
      .filter((date) => date.length === 8)
      .sort();
  }

  private calculateSyncPercent(current: number, total: number): number {
    if (total <= 0) return 100;
    return Math.round((10 + (current / total) * 90) * 10) / 10;
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

  private async resolveSyncRange(dto: SyncASharesDto): Promise<{ startDate: string; endDate: string }> {
    if (dto.tradeDate) return { startDate: dto.tradeDate, endDate: dto.tradeDate };
    if (dto.startDate && dto.endDate) return { startDate: dto.startDate, endDate: dto.endDate };

    const endDate = this.formatChinaDate(new Date());
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 14);
    const startDate = this.formatChinaDate(start);
    const rows = await this.tushareClient.query(
      'trade_cal',
      { exchange: 'SSE', start_date: startDate, end_date: endDate, is_open: 1 },
      'cal_date,is_open',
    );
    const openDates = rows
      .map((row) => this.asString(row.cal_date))
      .filter((date) => date.length === 8)
      .sort();
    const latest = openDates.length ? openDates[openDates.length - 1] : undefined;
    const tradeDate = latest ?? endDate;
    return { startDate: tradeDate, endDate: tradeDate };
  }

  private formatChinaDate(date: Date): string {
    const utcMs = date.getTime() + 8 * 60 * 60 * 1000;
    const china = new Date(utcMs);
    const year = china.getUTCFullYear();
    const month = String(china.getUTCMonth() + 1).padStart(2, '0');
    const day = String(china.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  private asString(value: TushareRow[string]): string {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  private asNullableString(value: TushareRow[string]): string | null {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  }
}
