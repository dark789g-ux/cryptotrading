import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UsSymbolEntity } from '../../entities/raw/us-symbol.entity';
import { QuantJobsService } from '../../modules/quant/services/quant-jobs.service';
import type { ValidatedCreateJob } from '../../modules/quant/dto/create-job.dto';
import {
  asNullableNumber,
  asNumber,
  formatTradeDateLabel,
} from './utils/us-stocks-format.util';
import { appendUsStocksSort, buildUsStocksBaseQuery } from './data-access/us-stocks-query.sql';
import {
  UsStockFilterOptions,
  UsStockKlineRow,
  UsStockQueryBody,
  UsStockQueryResult,
  UsStockSummary,
  UsStockSyncBody,
} from './us-stocks.types';

export type {
  UsStockKlineRow,
  UsStockQueryBody,
  UsStockQueryResult,
  UsStockSyncBody,
} from './us-stocks.types';

const YYYYMMDD_RE = /^\d{8}$/;

@Injectable()
export class UsStocksService {
  constructor(
    @InjectRepository(UsSymbolEntity)
    private readonly symbolRepo: Repository<UsSymbolEntity>,
    private readonly dataSource: DataSource,
    private readonly quantJobs: QuantJobsService,
  ) {}

  async query(dto: UsStockQueryBody): Promise<UsStockQueryResult> {
    const page = Math.max(1, Number(dto.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(dto.pageSize ?? 10)));

    const baseQuery = buildUsStocksBaseQuery(dto);

    const countRows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*) FROM (${baseQuery.sql}) sub`,
      baseQuery.params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    let sql = appendUsStocksSort(baseQuery.sql, dto);
    sql += ` LIMIT $${baseQuery.nextParamIndex} OFFSET $${baseQuery.nextParamIndex + 1}`;

    const rows = await this.dataSource.query<Array<Record<string, string | number | null>>>(sql, [
      ...baseQuery.params,
      pageSize,
      (page - 1) * pageSize,
    ]);

    return { rows, total, page, pageSize };
  }

  async getSummary(): Promise<UsStockSummary> {
    const rows = await this.dataSource.query<Array<Record<string, string | null>>>(`
      WITH latest AS (
        SELECT MAX(trade_date) AS trade_date FROM raw.us_daily_quote
      )
      SELECT
        (SELECT COUNT(*) FROM raw.us_symbol) AS "totalSymbols",
        (SELECT COUNT(*) FROM raw.us_symbol WHERE tracked = true) AS "trackedSymbols",
        latest.trade_date AS "latestTradeDate",
        COUNT(q.ticker) FILTER (WHERE COALESCE(q.qfq_pct_chg, q.pct_chg)::numeric > 0) AS "upCount",
        COUNT(q.ticker) FILTER (WHERE COALESCE(q.qfq_pct_chg, q.pct_chg)::numeric < 0) AS "downCount",
        COUNT(q.ticker) AS "quotedCount"
      FROM latest
      LEFT JOIN raw.us_daily_quote q ON q.trade_date = latest.trade_date
      GROUP BY latest.trade_date
    `);
    return (
      (rows[0] as unknown as UsStockSummary) ?? {
        totalSymbols: '0',
        trackedSymbols: '0',
        latestTradeDate: null,
        upCount: '0',
        downCount: '0',
        quotedCount: '0',
      }
    );
  }

  async getFilterOptions(): Promise<UsStockFilterOptions> {
    const themes = await this.symbolRepo
      .createQueryBuilder('s')
      .select('DISTINCT s.theme', 'value')
      .where('s.theme IS NOT NULL')
      .andWhere("s.theme <> ''")
      .orderBy('s.theme')
      .getRawMany<{ value: string }>();
    const stockTypes = await this.symbolRepo
      .createQueryBuilder('s')
      .select('DISTINCT s.stockType', 'value')
      .where('s.stockType IS NOT NULL')
      .andWhere("s.stockType <> ''")
      .orderBy('s.stockType')
      .getRawMany<{ value: string }>();
    return { themes, stockTypes };
  }

  async getDateRange(): Promise<{ min: string | null; max: string | null }> {
    const rows = await this.dataSource.query<Array<{ min: string | null; max: string | null }>>(`
      SELECT
        MIN(trade_date) AS min,
        MAX(trade_date) AS max
      FROM raw.us_daily_quote
    `);
    return rows[0] ?? { min: null, max: null };
  }

  async getKlines(
    ticker: string,
    limit = 300,
    priceMode: 'qfq' | 'raw' = 'qfq',
    range?: { startDate?: string; endDate?: string },
  ): Promise<UsStockKlineRow[]> {
    const safeLimit = Math.min(1000, Math.max(30, Number(limit) || 300));
    const priceCols =
      priceMode === 'raw'
        ? { open: 'q.open', high: 'q.high', low: 'q.low', close: 'q.close', pctChg: 'q.pct_chg' }
        : {
            open: 'q.qfq_open',
            high: 'q.qfq_high',
            low: 'q.qfq_low',
            close: 'q.qfq_close',
            pctChg: 'q.qfq_pct_chg',
          };

    const params: (string | number)[] = [ticker];
    let dateWhere = '';
    if (range?.startDate) {
      params.push(range.startDate);
      dateWhere += ` AND q.trade_date >= $${params.length}`;
    }
    if (range?.endDate) {
      params.push(range.endDate);
      dateWhere += ` AND q.trade_date <= $${params.length}`;
    }
    params.push(safeLimit);
    const limitParam = `$${params.length}`;

    const rows = await this.dataSource.query<Array<Record<string, string | number | null>>>(
      `
      SELECT *
      FROM (
        SELECT
          q.trade_date AS "tradeDate",
          ${priceCols.open} AS open,
          ${priceCols.high} AS high,
          ${priceCols.low} AS low,
          ${priceCols.close} AS close,
          ${priceCols.pctChg} AS "pctChg",
          q.volume,
          i.dif,
          i.dea,
          i.macd,
          i.kdj_k AS "kdjK",
          i.kdj_d AS "kdjD",
          i.kdj_j AS "kdjJ",
          i.bbi,
          i.ma5,
          i.ma30,
          i.ma60,
          i.ma120,
          i.ma240,
          i.atr_14 AS "atr14",
          i.low_9 AS "low9",
          i.high_9 AS "high9",
          i.stop_loss_pct AS "stopLossPct",
          i.risk_reward_ratio AS "riskRewardRatio"
        FROM raw.us_daily_quote q
        LEFT JOIN raw.us_daily_indicator i ON i.ticker = q.ticker AND i.trade_date = q.trade_date
        WHERE q.ticker = $1
          AND ${priceCols.open} IS NOT NULL
          AND ${priceCols.high} IS NOT NULL
          AND ${priceCols.low} IS NOT NULL
          AND ${priceCols.close} IS NOT NULL
          ${dateWhere}
        ORDER BY q.trade_date DESC
        LIMIT ${limitParam}
      ) recent
      ORDER BY "tradeDate" ASC
    `,
      params,
    );

    return rows.map((row) => ({
      open_time: formatTradeDateLabel(String(row.tradeDate ?? '')),
      open: asNumber(row.open),
      high: asNumber(row.high),
      low: asNumber(row.low),
      close: asNumber(row.close),
      pctChg: asNullableNumber(row.pctChg),
      volume: asNumber(row.volume),
      DIF: asNullableNumber(row.dif),
      DEA: asNullableNumber(row.dea),
      MACD: asNullableNumber(row.macd),
      'KDJ.K': asNullableNumber(row.kdjK),
      'KDJ.D': asNullableNumber(row.kdjD),
      'KDJ.J': asNullableNumber(row.kdjJ),
      BBI: asNullableNumber(row.bbi),
      MA5: asNullableNumber(row.ma5),
      MA30: asNullableNumber(row.ma30),
      MA60: asNullableNumber(row.ma60),
      MA120: asNullableNumber(row.ma120),
      MA240: asNullableNumber(row.ma240),
      atr_14: asNullableNumber(row.atr14),
      low_9: asNullableNumber(row.low9),
      high_9: asNullableNumber(row.high9),
      stop_loss_pct: asNullableNumber(row.stopLossPct),
      risk_reward_ratio: asNullableNumber(row.riskRewardRatio),
    }));
  }

  /**
   * 派 us_sync 作业（写一行 ml.jobs，复用 QuantJobsService.create）。
   *
   * us_sync 不属 LABEL_REF / FEATURE_SET run_type，create() 不展开 labelRef / 不校验 feature_set，
   * 直接落 pending。params 用 snake_case `date_range` / `tickers`（Python worker 读）。
   */
  async sync(body: UsStockSyncBody, createdBy: string | null): Promise<{ jobId: string }> {
    const params: Record<string, unknown> = {};

    if (body?.dateRange !== undefined) {
      const range = body.dateRange;
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !YYYYMMDD_RE.test(range[0]) ||
        !YYYYMMDD_RE.test(range[1])
      ) {
        throw new BadRequestException('dateRange 必须是 [YYYYMMDD, YYYYMMDD] 二元组');
      }
      if (range[0] > range[1]) {
        throw new BadRequestException(`dateRange 起始 ${range[0]} 不得晚于结束 ${range[1]}`);
      }
      params.date_range = range;
    }

    if (body?.tickers !== undefined) {
      if (!Array.isArray(body.tickers) || body.tickers.some((t) => typeof t !== 'string' || t === '')) {
        throw new BadRequestException('tickers 必须是非空字符串数组');
      }
      params.tickers = body.tickers;
    }

    const dto: ValidatedCreateJob = {
      runType: 'us_sync',
      params,
      priority: 100,
      maxAttempts: 1,
    };
    const job = await this.quantJobs.create(dto, createdBy);
    return { jobId: job.id };
  }
}
