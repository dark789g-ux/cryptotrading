import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomIndexDailyIndicatorEntity } from '../../../entities/custom-index/custom-index-daily-indicator.entity';
import { calcBrickChartPoints } from '../../../indicators/brick-chart';
import { calcIndicators, KlineRow } from '../../../indicators/indicators';
import { batchUpsert } from '../../_shared/sync-helpers';
import type { IndexQuoteRow } from './custom-index-compute.types';

/**
 * 自定义指数日线指标计算。
 *
 * 复用 indicators/indicators.ts 的 calcIndicators 与 brick-chart.calcBrickChartPoints，
 * 模式对齐 ThsIndexDailyIndicatorService。
 */
@Injectable()
export class CustomIndexIndicatorService {
  private readonly logger = new Logger(CustomIndexIndicatorService.name);

  constructor(
    @InjectRepository(CustomIndexDailyIndicatorEntity)
    private readonly indicatorsRepo: Repository<CustomIndexDailyIndicatorEntity>,
  ) {}

  async upsertIndicatorsFromQuotes(
    customIndexId: string,
    quotes: readonly IndexQuoteRow[],
  ): Promise<number> {
    const rows = quotes.filter(
      (q) =>
        q.open != null &&
        q.high != null &&
        q.low != null &&
        q.close != null,
    );

    if (rows.length === 0) {
      return 0;
    }

    try {
      const klineRows: KlineRow[] = rows.map((q) => ({
        open_time: q.tradeDate,
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: 0,
        quote_volume: q.amount ?? undefined,
      }));
      const withIndicators = calcIndicators(klineRows);
      const brickPoints = calcBrickChartPoints(
        rows.map((q) => ({
          high: q.high!,
          low: q.low!,
          close: q.close!,
        })),
      );

      const entities = withIndicators.map((row, i) => {
        const hasAmount = rows[i].amount != null;
        return this.indicatorsRepo.create({
          customIndexId,
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
        });
      });

      return batchUpsert(this.indicatorsRepo, entities, [
        'customIndexId',
        'tradeDate',
      ]);
    } catch (err) {
      this.logger.error(
        `custom_index_indicator id=${customIndexId} 计算失败：${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }
}
