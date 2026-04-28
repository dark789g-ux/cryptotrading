import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AShareDailyIndicatorEntity } from '../../../entities/a-share/a-share-daily-indicator.entity';
import { AShareIndicatorCalcStateEntity } from '../../../entities/a-share/a-share-indicator-calc-state.entity';
import { calcBrickChartPoints } from '../../../indicators/brick-chart';
import { calcIndicators, KlineRow } from '../../../indicators/indicators';
import { calcIndicatorsStreaming, normalizeIndicatorCalcState } from '../../../indicators/indicators-stream';
import { ASharesSyncRange, AShareQuoteForIndicator } from '../a-shares.types';

type ASharesSymbolProgressCallback = (current: number, total: number, tsCode: string) => void;

@Injectable()
export class ASharesIndicatorService {
  constructor(
    @InjectRepository(AShareDailyIndicatorEntity)
    private readonly indicatorRepo: Repository<AShareDailyIndicatorEntity>,
    @InjectRepository(AShareIndicatorCalcStateEntity)
    private readonly calcStateRepo: Repository<AShareIndicatorCalcStateEntity>,
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

  async recalculateDirtyIndicatorsForSymbols(
    tsCodes: string[],
    onProgress?: ASharesSymbolProgressCallback,
  ): Promise<number> {
    let count = 0;
    const targetTsCodes = [...new Set(tsCodes)].filter((value) => value.length > 0).sort();
    for (let index = 0; index < targetTsCodes.length; index++) {
      const tsCode = targetTsCodes[index];
      count += await this.recalculateDirtyIndicatorsForSymbol(tsCode);
      onProgress?.(index + 1, targetTsCodes.length, tsCode);
    }
    return count;
  }

  private async recalculateDirtyIndicatorsForSymbol(tsCode: string): Promise<number> {
    const syncRows = await this.dataSource.query<Array<{ dirtyFrom: string | null }>>(`
      SELECT indicator_dirty_from_date AS "dirtyFrom"
      FROM a_share_sync_states
      WHERE ts_code = $1
    `, [tsCode]);
    const dirtyFrom = syncRows[0]?.dirtyFrom;
    if (!dirtyFrom) return 0;

    const seedRows = await this.dataSource.query<Array<{ tradeDate: string; state: unknown }>>(`
      SELECT trade_date AS "tradeDate", state
      FROM a_share_indicator_calc_states
      WHERE ts_code = $1
        AND trade_date < $2
      ORDER BY trade_date DESC
      LIMIT 1
    `, [tsCode, dirtyFrom]);
    const seedState = normalizeIndicatorCalcState(seedRows[0]?.state);
    const startDate = seedState ? dirtyFrom : null;

    const rows = await this.loadQuoteRows(tsCode, startDate);
    if (!rows.length) return 0;

    const calculated = calcIndicatorsStreaming(rows.map((row): KlineRow => ({
      open_time: row.tradeDate,
      open: row.qfqOpen ?? 0,
      high: row.qfqHigh ?? 0,
      low: row.qfqLow ?? 0,
      close: row.qfqClose ?? 0,
      volume: row.vol ?? 0,
      quote_volume: row.amount ?? 0,
    })), seedState);

    const entities = calculated.map(({ row, brickChart }, index) =>
      this.createIndicatorEntity(tsCode, rows[index].tradeDate, row, brickChart),
    );
    const states = calculated.map(({ state }, index) => this.calcStateRepo.create({
      tsCode,
      tradeDate: rows[index].tradeDate,
      state: state as unknown as Record<string, unknown>,
    }));
    await this.upsertInChunks(this.indicatorRepo, entities, ['tsCode', 'tradeDate']);
    await this.upsertInChunks(this.calcStateRepo, states, ['tsCode', 'tradeDate']);

    const latestTradeDate = rows[rows.length - 1].tradeDate;
    await this.dataSource.query(`
      INSERT INTO a_share_sync_states (ts_code, indicator_dirty_from_date, indicator_calculated_to_date, updated_at)
      VALUES ($1, NULL, $2, now())
      ON CONFLICT (ts_code) DO UPDATE SET
        indicator_dirty_from_date = NULL,
        indicator_calculated_to_date = EXCLUDED.indicator_calculated_to_date,
        updated_at = now()
    `, [tsCode, latestTradeDate]);
    return rows.length;
  }

  private async recalculateIndicatorsForSymbol(tsCode: string): Promise<number> {
    const rows = await this.loadQuoteRows(tsCode, null);
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
      this.createIndicatorEntity(tsCode, rows[index].tradeDate, row, brickChart[index] ?? null),
    );
    await this.upsertInChunks(this.indicatorRepo, entities, ['tsCode', 'tradeDate']);
    return entities.length;
  }

  private async loadQuoteRows(tsCode: string, startDate: string | null): Promise<AShareQuoteForIndicator[]> {
    const params = startDate ? [tsCode, startDate] : [tsCode];
    return this.dataSource.query<AShareQuoteForIndicator[]>(`
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
        ${startDate ? 'AND trade_date >= $2' : ''}
        AND qfq_open IS NOT NULL
        AND qfq_high IS NOT NULL
        AND qfq_low IS NOT NULL
        AND qfq_close IS NOT NULL
      ORDER BY trade_date ASC
    `, params);
  }

  private createIndicatorEntity(
    tsCode: string,
    tradeDate: string,
    row: ReturnType<typeof calcIndicators>[number],
    brickChart: { brick: number; delta: number; xg: boolean } | null,
  ): AShareDailyIndicatorEntity {
    return this.indicatorRepo.create({
      tsCode,
      tradeDate,
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
      brick: brickChart?.brick ?? null,
      brickDelta: brickChart?.delta ?? null,
      brickXg: brickChart?.xg ?? null,
    });
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
