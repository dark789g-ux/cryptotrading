import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThsIndexDailyQuoteEntity } from '../../entities/ths-index-daily/ths-index-daily-quote.entity';
import { ThsIndexDailyIndicatorEntity } from '../../entities/ths-index-daily/ths-index-daily-indicator.entity';
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
    @InjectRepository(ThsIndexDailyQuoteEntity)
    private readonly quotesRepo: Repository<ThsIndexDailyQuoteEntity>,
    @InjectRepository(ThsIndexDailyIndicatorEntity)
    private readonly indicatorsRepo: Repository<ThsIndexDailyIndicatorEntity>,
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

  private async recalculateForSymbol(tsCode: string): Promise<number> {
    const rows = await this.quotesRepo
      .createQueryBuilder('q')
      .select(['q.tsCode', 'q.tradeDate', 'q.open', 'q.high', 'q.low', 'q.close'])
      .where('q.tsCode = :ts', { ts: tsCode })
      .andWhere('q.open IS NOT NULL')
      .andWhere('q.high IS NOT NULL')
      .andWhere('q.low IS NOT NULL')
      .andWhere('q.close IS NOT NULL')
      .orderBy('q.tradeDate', 'ASC')
      .getMany();

    if (!rows.length) return 0;

    const klineRows: KlineRow[] = rows.map((r) => ({
      open_time: r.tradeDate,
      open: r.open ?? 0,
      high: r.high ?? 0,
      low: r.low ?? 0,
      close: r.close ?? 0,
      volume: 0,
    }));
    const withIndicators = calcIndicators(klineRows);
    const brickPoints = calcBrickChartPoints(
      rows.map((r) => ({ high: r.high ?? 0, low: r.low ?? 0, close: r.close ?? 0 })),
    );

    const entities = withIndicators.map((row, i) =>
      this.indicatorsRepo.create({
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
      }),
    );

    return batchUpsert(this.indicatorsRepo, entities, ['tsCode', 'tradeDate']);
  }
}
