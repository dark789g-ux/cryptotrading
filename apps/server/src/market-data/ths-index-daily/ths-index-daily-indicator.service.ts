import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';
import { calcIndicators, KlineRow } from '../../indicators/indicators';
import { calcBrickChartPoints } from '../../indicators/brick-chart';
import { batchUpsert } from '../_shared/sync-helpers';

/**
 * 指数日线指标计算。
 *
 * 复用 apps/server/src/indicators/indicators.ts 的 calcIndicators（与 a-shares-indicator 数学等价），
 * 但只消费 MA / MACD / KDJ / BBI 字段，忽略 ATR / quote_volume_10 / 9日高低 等个股交易专用项；
 * BRICK 直接复用 brick-chart.calcBrickChartPoints。
 */
@Injectable()
export class ThsIndexDailyIndicatorService {
  private readonly logger = new Logger(ThsIndexDailyIndicatorService.name);

  constructor(
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly quotesRepo: Repository<IndexDailyQuoteEntity>,
    @InjectRepository(IndexDailyIndicatorEntity)
    private readonly indicatorsRepo: Repository<IndexDailyIndicatorEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 重算某一批 ts_code 的全部指标（取所有历史 quotes，覆盖式 upsert）。
   * 用于同步任务收尾：增量同步落库新行后，按受影响 ts_code 触发本方法。
   */
  async recalculateForSymbols(tsCodes: string[]): Promise<number> {
    let written = 0;
    const unique = [...new Set(tsCodes)].filter((c) => c.length > 0).sort();
    for (const tsCode of unique) {
      try {
        written += await this.recalculateForSymbol(tsCode);
      } catch (err) {
        this.logger.error(
          `ths_index_indicator ts_code=${tsCode} 计算失败：${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        throw err;
      }
    }
    return written;
  }

  private async backfillIndexAmount(
    tsCode: string,
    category: string,
  ): Promise<Map<string, number | null>> {
    if (category === 'market') return new Map();

    const minMax = await this.quotesRepo
      .createQueryBuilder('q')
      .select('MIN(q.tradeDate)', 'minDate')
      .addSelect('MAX(q.tradeDate)', 'maxDate')
      .where('q.tsCode = :ts', { ts: tsCode })
      .getRawOne();
    const minDate = minMax?.minDate;
    const maxDate = minMax?.maxDate;
    if (!minDate || !maxDate) return new Map();

    const amountMap = new Map<string, number | null>();

    if (category === 'sw') {
      const rows = await this.dataSource.query<{ tradeDate: string; amount: number | null }[]>(
        `
          UPDATE index_daily_quotes q
          SET amount = agg.amount
          FROM (
            SELECT dq.trade_date, SUM(dq.amount) AS amount
            FROM raw.daily_quote dq
            JOIN raw.index_member im
              ON (im.l1_code = $1 OR im.l2_code = $1 OR im.l3_code = $1)
              AND im.out_date IS NULL
            WHERE dq.ts_code = im.ts_code
              AND dq.trade_date BETWEEN $2 AND $3
            GROUP BY dq.trade_date
          ) agg
          WHERE q.ts_code = $1 AND q.trade_date = agg.trade_date
          RETURNING q.trade_date AS "tradeDate", q.amount AS amount
        `,
        [tsCode, minDate, maxDate],
      );
      for (const r of rows) {
        amountMap.set(r.tradeDate, r.amount);
      }
    } else {
      const rows = await this.dataSource.query<{ tradeDate: string; amount: number | null }[]>(
        `
          UPDATE index_daily_quotes q
          SET amount = agg.amount
          FROM (
            SELECT dq.trade_date, SUM(dq.amount) AS amount
            FROM raw.daily_quote dq
            JOIN ths_member_stocks tms ON tms.con_code = dq.ts_code
            WHERE tms.ts_code = $1
              AND dq.trade_date BETWEEN $2 AND $3
            GROUP BY dq.trade_date
          ) agg
          WHERE q.ts_code = $1 AND q.trade_date = agg.trade_date
          RETURNING q.trade_date AS "tradeDate", q.amount AS amount
        `,
        [tsCode, minDate, maxDate],
      );
      for (const r of rows) {
        amountMap.set(r.tradeDate, r.amount);
      }
    }

    return amountMap;
  }

  private async recalculateForSymbol(tsCode: string): Promise<number> {
    const rows = await this.quotesRepo
      .createQueryBuilder('q')
      .select([
        'q.tsCode',
        'q.tradeDate',
        'q.open',
        'q.high',
        'q.low',
        'q.close',
        'q.volHand',
        'q.amount',
        'q.category',
      ])
      .where('q.tsCode = :ts', { ts: tsCode })
      .andWhere('q.open IS NOT NULL')
      .andWhere('q.high IS NOT NULL')
      .andWhere('q.low IS NOT NULL')
      .andWhere('q.close IS NOT NULL')
      .orderBy('q.tradeDate', 'ASC')
      .getMany();

    if (!rows.length) return 0;

    const amountMap = await this.backfillIndexAmount(tsCode, rows[0].category);
    if (amountMap.size > 0) {
      for (const r of rows) {
        if (amountMap.has(r.tradeDate)) r.amount = amountMap.get(r.tradeDate) ?? null;
      }
    }

    const klineRows: KlineRow[] = rows.map((r) => ({
      open_time: r.tradeDate,
      open: r.open ?? 0,
      high: r.high ?? 0,
      low: r.low ?? 0,
      close: r.close ?? 0,
      volume: r.volHand ?? 0,
      quote_volume: r.amount ?? undefined,
    }));
    const withIndicators = calcIndicators(klineRows);
    const brickPoints = calcBrickChartPoints(
      rows.map((r) => ({ high: r.high ?? 0, low: r.low ?? 0, close: r.close ?? 0 })),
    );

    const entities = withIndicators.map((row, i) => {
      const hasAmount = rows[i].amount != null;
      return this.indicatorsRepo.create({
        tsCode,
        tradeDate: rows[i].tradeDate,
        ma5: row.MA5,
        ma30: row.MA30,
        ma60: row.MA60,
        ma120: row.MA120,
        ma240: row.MA240,
        dif: row.DIF,
        dea: row.DEA,
        macd: row.MACD,
        kdjK: row['KDJ.K'],
        kdjD: row['KDJ.D'],
        kdjJ: row['KDJ.J'],
        bbi: row.BBI,
        brick: brickPoints[i]?.brick ?? null,
        brickDelta: brickPoints[i]?.delta ?? null,
        brickXg: brickPoints[i]?.xg ?? null,
        obv5d: hasAmount ? row.obv5d : null,
        obv10d: hasAmount ? row.obv10d : null,
        obv20d: hasAmount ? row.obv20d : null,
        category: rows[i].category,
      });
    });

    return batchUpsert(this.indicatorsRepo, entities, ['tsCode', 'tradeDate']);
  }
}
