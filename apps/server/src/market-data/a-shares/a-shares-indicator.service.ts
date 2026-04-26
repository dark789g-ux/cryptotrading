import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AShareDailyIndicatorEntity } from '../../entities/a-share/a-share-daily-indicator.entity';
import { calcBrickChartPoints } from '../../indicators/brick-chart';
import { calcIndicators, KlineRow } from '../../indicators/indicators';
import { ASharesSyncRange, AShareQuoteForIndicator } from './a-shares.types';

@Injectable()
export class ASharesIndicatorService {
  constructor(
    @InjectRepository(AShareDailyIndicatorEntity)
    private readonly indicatorRepo: Repository<AShareDailyIndicatorEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async recalculateIndicatorsForRange(range: ASharesSyncRange): Promise<number> {
    const changedRows = await this.dataSource.query<Array<{ tsCode: string }>>(`
      SELECT DISTINCT ts_code AS "tsCode"
      FROM a_share_daily_quotes
      WHERE trade_date BETWEEN $1 AND $2
      ORDER BY ts_code
    `, [range.startDate, range.endDate]);
    const tsCodes = changedRows.map((row) => row.tsCode).filter((tsCode) => tsCode.length > 0);
    let count = 0;
    for (const tsCode of tsCodes) {
      count += await this.recalculateIndicatorsForSymbol(tsCode);
    }
    return count;
  }

  async recalculateIndicatorsForSymbols(tsCodes: string[]): Promise<number> {
    let count = 0;
    for (const tsCode of [...new Set(tsCodes)].filter((value) => value.length > 0).sort()) {
      count += await this.recalculateIndicatorsForSymbol(tsCode);
    }
    return count;
  }

  private async recalculateIndicatorsForSymbol(tsCode: string): Promise<number> {
    const rows = await this.dataSource.query<AShareQuoteForIndicator[]>(`
      SELECT
        ts_code AS "tsCode",
        trade_date AS "tradeDate",
        qfq_open AS "qfqOpen",
        qfq_high AS "qfqHigh",
        qfq_low AS "qfqLow",
        qfq_close AS "qfqClose",
        vol,
        amount
      FROM a_share_daily_quotes
      WHERE ts_code = $1
        AND qfq_open IS NOT NULL
        AND qfq_high IS NOT NULL
        AND qfq_low IS NOT NULL
        AND qfq_close IS NOT NULL
      ORDER BY trade_date ASC
    `, [tsCode]);
    if (!rows.length) return 0;

    const withIndicators = calcIndicators(rows.map((row): KlineRow => ({
      open_time: row.tradeDate,
      open: row.qfqOpen ?? 0,
      high: row.qfqHigh ?? 0,
      low: row.qfqLow ?? 0,
      close: row.qfqClose ?? 0,
      volume: row.vol ?? 0,
      quote_volume: row.amount ?? 0,
    })));
    const brickChart = calcBrickChartPoints(rows.map((row) => ({
      high: Number(row.qfqHigh ?? 0),
      low: Number(row.qfqLow ?? 0),
      close: Number(row.qfqClose ?? 0),
    })));

    const entities = withIndicators.map((row, index) =>
      this.indicatorRepo.create({
        tsCode,
        tradeDate: rows[index].tradeDate,
        dif: row.DIF,
        dea: row.DEA,
        macd: row.MACD,
        kdjK: row['KDJ.K'],
        kdjD: row['KDJ.D'],
        kdjJ: row['KDJ.J'],
        bbi: row.BBI,
        ma5: row.MA5,
        ma30: row.MA30,
        ma60: row.MA60,
        ma120: row.MA120,
        ma240: row.MA240,
        quoteVolume10: row['10_quote_volume'],
        atr14: row.atr_14,
        lossAtr14: row.loss_atr_14,
        low9: row.low_9,
        high9: row.high_9,
        stopLossPct: row.stop_loss_pct,
        riskRewardRatio: row.risk_reward_ratio,
        brick: brickChart[index]?.brick ?? null,
        brickDelta: brickChart[index]?.delta ?? null,
        brickXg: brickChart[index]?.xg ?? null,
      }),
    );
    await this.upsertInChunks(this.indicatorRepo, entities, ['tsCode', 'tradeDate']);
    return entities.length;
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
