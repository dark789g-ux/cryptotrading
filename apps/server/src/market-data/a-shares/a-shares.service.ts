import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import {
  asNullableNumber,
  asNumber,
  formatTradeDateLabel,
} from './a-shares-format.util';
import { buildASharesBaseQuery, appendASharesSort } from './a-shares-query.sql';
import { ASharesSyncService } from './a-shares-sync.service';
import {
  AShareKlineRow,
  ASharesSyncEvent,
  ASharesSyncResult,
  QueryASharesDto,
  SyncASharesDto,
} from './a-shares.types';

export type {
  AShareKlineRow,
  ASharesSyncEvent,
  ASharesSyncResult,
  QueryASharesDto,
  SyncASharesDto,
} from './a-shares.types';

@Injectable()
export class ASharesService {
  private isSyncing = false;

  constructor(
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    private readonly dataSource: DataSource,
    private readonly syncService: ASharesSyncService,
  ) {}

  async sync(dto: SyncASharesDto = {}): Promise<ASharesSyncResult> {
    return this.syncService.syncWithProgress(dto);
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
      this.syncService.syncWithProgress(dto, (event) => subject.next(event))
        .then((result) => {
          const message = result.status === 'partial'
            ? `A 股数据部分完成，失败 ${result.failedCount} 项`
            : result.status === 'error'
              ? `A 股数据同步未完成，失败 ${result.failedCount} 项`
              : 'A 股数据同步完成';
          subject.next({ type: 'done', message, ...result });
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
        COUNT(q.ts_code) FILTER (WHERE COALESCE(q.qfq_pct_chg, q.pct_chg)::numeric > 0) AS "upCount",
        COUNT(q.ts_code) FILTER (WHERE COALESCE(q.qfq_pct_chg, q.pct_chg)::numeric < 0) AS "downCount",
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
    const baseQuery = buildASharesBaseQuery(dto);

    const countRows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*) FROM (${baseQuery.sql}) sub`,
      baseQuery.params,
    );
    const total = Number(countRows[0]?.count ?? 0);
    let sql = appendASharesSort(baseQuery.sql, dto);
    sql += ` LIMIT $${baseQuery.nextParamIndex} OFFSET $${baseQuery.nextParamIndex + 1}`;

    const rows = await this.dataSource.query<Array<Record<string, string | null>>>(
      sql,
      [...baseQuery.params, pageSize, (page - 1) * pageSize],
    );
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

  async getDateRange(): Promise<{ min: string | null; max: string | null }> {
    const rows = await this.dataSource.query<Array<{ min: string | null; max: string | null }>>(`
      SELECT
        MIN(trade_date) AS min,
        MAX(trade_date) AS max
      FROM a_share_daily_quotes
    `);
    return rows[0] ?? { min: null, max: null };
  }

  async getKlines(tsCode: string, limit = 300, priceMode: 'qfq' | 'raw' = 'qfq'): Promise<AShareKlineRow[]> {
    const safeLimit = Math.min(1000, Math.max(30, Number(limit) || 300));
    const priceCols = priceMode === 'raw'
      ? { open: 'q.open', high: 'q.high', low: 'q.low', close: 'q.close', pctChg: 'q.pct_chg' }
      : { open: 'q.qfq_open', high: 'q.qfq_high', low: 'q.qfq_low', close: 'q.qfq_close', pctChg: 'q.qfq_pct_chg' };
    const rows = await this.dataSource.query<Array<Record<string, string | number | boolean | null>>>(`
      SELECT *
      FROM (
        SELECT
          q.trade_date AS "tradeDate",
          ${priceCols.open} AS open,
          ${priceCols.high} AS high,
          ${priceCols.low} AS low,
          ${priceCols.close} AS close,
          ${priceCols.pctChg} AS "pctChg",
          q.vol,
          q.amount,
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
          i.quote_volume_10 AS "quoteVolume10",
          i.atr_14 AS "atr14",
          i.loss_atr_14 AS "lossAtr14",
          i.low_9 AS "low9",
          i.high_9 AS "high9",
        i.stop_loss_pct AS "stopLossPct",
        i.risk_reward_ratio AS "riskRewardRatio",
        i.brick,
        i.brick_delta AS "brickDelta",
        i.brick_xg AS "brickXg",
        m.turnover_rate AS "turnoverRate",
        m.volume_ratio AS "volumeRatio",
          m.pe,
          m.pb,
          m.total_mv AS "totalMv",
          m.circ_mv AS "circMv"
        FROM a_share_daily_quotes q
        LEFT JOIN a_share_daily_indicators i ON i.ts_code = q.ts_code AND i.trade_date = q.trade_date
        LEFT JOIN a_share_daily_metrics m ON m.ts_code = q.ts_code AND m.trade_date = q.trade_date
        WHERE q.ts_code = $1
          AND ${priceCols.open} IS NOT NULL
          AND ${priceCols.high} IS NOT NULL
          AND ${priceCols.low} IS NOT NULL
          AND ${priceCols.close} IS NOT NULL
        ORDER BY q.trade_date DESC
        LIMIT $2
      ) recent
      ORDER BY "tradeDate" ASC
    `, [tsCode, safeLimit]);

    return rows.map((row) => {
      const brick = asNullableNumber(row.brick);
      const brickDelta = asNullableNumber(row.brickDelta);
      return {
        open_time: formatTradeDateLabel(String(row.tradeDate ?? '')),
        open: asNumber(row.open),
        high: asNumber(row.high),
        low: asNumber(row.low),
        close: asNumber(row.close),
        pctChg: asNullableNumber(row.pctChg),
        volume: asNumber(row.vol),
        quote_volume: asNumber(row.amount),
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
        '10_quote_volume': asNullableNumber(row.quoteVolume10),
        atr_14: asNullableNumber(row.atr14),
        loss_atr_14: asNullableNumber(row.lossAtr14),
        low_9: asNullableNumber(row.low9),
        high_9: asNullableNumber(row.high9),
        stop_loss_pct: asNullableNumber(row.stopLossPct),
        risk_reward_ratio: asNullableNumber(row.riskRewardRatio),
        turnoverRate: asNullableNumber(row.turnoverRate),
        volumeRatio: asNullableNumber(row.volumeRatio),
        pe: asNullableNumber(row.pe),
        pb: asNullableNumber(row.pb),
        totalMv: asNullableNumber(row.totalMv),
        circMv: asNullableNumber(row.circMv),
        brickChart: brick == null || brickDelta == null
          ? undefined
          : { brick, delta: brickDelta, xg: row.brickXg === true },
      };
    });
  }
}
