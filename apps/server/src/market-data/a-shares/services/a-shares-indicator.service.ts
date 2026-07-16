import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DailyIndicatorEntity } from '../../../entities/raw/daily-indicator.entity';
import { IndicatorCalcStateEntity } from '../../../entities/raw/indicator-calc-state.entity';
import { calcBrickChartPoints } from '../../../indicators/brick-chart';
import { calcIndicators, KlineRow, KlineRowWithIndicators } from '../../../indicators/indicators';
import { IndicatorWorkerPool } from '../../../indicators/indicator-worker-pool';
import { calcIndicatorsStreaming, IndicatorCalcState, normalizeIndicatorCalcState } from '../../../indicators/indicators-stream';
import { ASharesSyncRange, AShareQuoteForIndicator } from '../a-shares.types';

type ASharesSymbolProgressCallback = (current: number, total: number, tsCode: string) => void;
const DIRTY_INDICATOR_CONCURRENCY = 5;

@Injectable()
export class ASharesIndicatorService {
  private readonly logger = new Logger(ASharesIndicatorService.name);

  constructor(
    @InjectRepository(DailyIndicatorEntity)
    private readonly indicatorRepo: Repository<DailyIndicatorEntity>,
    @InjectRepository(IndicatorCalcStateEntity)
    private readonly calcStateRepo: Repository<IndicatorCalcStateEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async recalculateIndicatorsForRange(range: ASharesSyncRange): Promise<number> {
    const changedRows = await this.dataSource.query<Array<{ tsCode: string }>>(`
      SELECT DISTINCT ts_code AS "tsCode"
      FROM raw.daily_quote
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
    let completed = 0;
    const targetTsCodes = [...new Set(tsCodes)].filter((value) => value.length > 0).sort();
    const workerPool = new IndicatorWorkerPool();

    try {
      for (let index = 0; index < targetTsCodes.length; index += DIRTY_INDICATOR_CONCURRENCY) {
        const batch = targetTsCodes.slice(index, index + DIRTY_INDICATOR_CONCURRENCY);
        const results = await Promise.all(batch.map(async (tsCode) => {
          const symbolCount = await this.recalculateDirtyIndicatorsForSymbol(tsCode, workerPool);
          onProgress?.(++completed, targetTsCodes.length, tsCode);
          return symbolCount;
        }));
        count += results.reduce((sum, value) => sum + value, 0);
      }
    } finally {
      await workerPool.terminate();
    }

    return count;
  }

  private async recalculateDirtyIndicatorsForSymbol(
    tsCode: string,
    workerPool?: IndicatorWorkerPool,
  ): Promise<number> {
    const syncRows = await this.dataSource.query<Array<{ dirtyFrom: string | null }>>(`
      SELECT indicator_dirty_from_date AS "dirtyFrom"
      FROM a_share_sync_states
      WHERE ts_code = $1
    `, [tsCode]);
    // 注：a_share_sync_states 不在 M0 raw schema 迁移范围，保留 public.* 现状（PG 默认 search_path 自动解析）
    const dirtyFrom = syncRows[0]?.dirtyFrom;
    if (!dirtyFrom) return 0;

    // 检测是否需要 IPO 全量重算
    const earliestRows = await this.dataSource.query<Array<{ minDate: string }>>(`
      SELECT MIN(trade_date) AS "minDate" FROM raw.daily_quote WHERE ts_code = $1
    `, [tsCode]);
    const earliestQuoteDate = earliestRows[0]?.minDate;
    const needsFullRecalc = !!earliestQuoteDate && earliestQuoteDate === dirtyFrom;

    if (needsFullRecalc) {
      return await this.recalculateIndicatorsForSymbol(tsCode);
    }

    const seedRows = await this.dataSource.query<Array<{ tradeDate: string; state: unknown }>>(`
      SELECT trade_date AS "tradeDate", state
      FROM raw.indicator_calc_state
      WHERE ts_code = $1
        AND trade_date < $2
      ORDER BY trade_date DESC
      LIMIT 1
    `, [tsCode, dirtyFrom]);
    const seedState = normalizeIndicatorCalcState(seedRows[0]?.state);
    const seedTradeDate = seedState ? seedRows[0]?.tradeDate : null;

    let effectiveSeedState = seedState;
    if (seedState && seedState.signedAmounts.length < 19) {
      effectiveSeedState = await this.repairSeedSignedAmounts(tsCode, seedTradeDate!, seedState);
    }

    const rows = effectiveSeedState && seedTradeDate
      ? await this.loadQuoteRowsAfter(tsCode, seedTradeDate)
      : await this.loadQuoteRows(tsCode, null);
    if (!rows.length) return 0;

    const klineRows = rows.map((row): KlineRow => ({
      open_time: row.tradeDate,
      open: row.qfqOpen ?? 0,
      high: row.qfqHigh ?? 0,
      low: row.qfqLow ?? 0,
      close: row.qfqClose ?? 0,
      volume: row.vol ?? 0,
      quote_volume: row.amount ?? 0,
      qfqClose: row.qfqClose ?? 0,
    }));
    const calculated = workerPool
      ? await workerPool.run(klineRows, effectiveSeedState)
      : calcIndicatorsStreaming(klineRows, effectiveSeedState);

    const entities = calculated.map(({ row, brickChart }, index) =>
      this.createIndicatorEntity(tsCode, rows[index].tradeDate, row, brickChart),
    ).filter((_, index) => !seedState || rows[index].tradeDate >= dirtyFrom);
    const stateEntities = this.createSparseCalcStateEntities(tsCode, rows, calculated);

    if (seedState) {
      await this.upsertInChunks(this.indicatorRepo, entities, ['tsCode', 'tradeDate']);
      await this.dataSource.query(`
        DELETE FROM raw.indicator_calc_state
        WHERE ts_code = $1
          AND trade_date >= $2
      `, [tsCode, dirtyFrom]);
    } else {
      await this.dataSource.query('DELETE FROM raw.daily_indicator WHERE ts_code = $1', [tsCode]);
      await this.dataSource.query('DELETE FROM raw.indicator_calc_state WHERE ts_code = $1', [tsCode]);
      await this.insertInChunks(this.indicatorRepo, entities);
    }
    await this.upsertInChunks(this.calcStateRepo, stateEntities, ['tsCode', 'tradeDate']);

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
      qfqClose: row.qfqClose ?? 0,
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

    // 全量重算后必须清空 dirty 标记并更新 calculated_to_date，否则下次同步会重复触发全量重算
    const latestTradeDate = rows[rows.length - 1].tradeDate;
    await this.dataSource.query(`
      INSERT INTO a_share_sync_states (ts_code, indicator_dirty_from_date, indicator_calculated_to_date, updated_at)
      VALUES ($1, NULL, $2, now())
      ON CONFLICT (ts_code) DO UPDATE SET
        indicator_dirty_from_date = NULL,
        indicator_calculated_to_date = EXCLUDED.indicator_calculated_to_date,
        updated_at = now()
    `, [tsCode, latestTradeDate]);

    // 全量重算后重建 seed，防止残留脏 seed 被增量路径复用污染 MA
    await this.rebuildSeedFromFullRecalc(tsCode, rows);

    // 采样对账：验证刚写入的 MA 值与独立重算一致（fail-open，仅告警）
    await this.verifyIndicatorSample(tsCode, latestTradeDate);

    return entities.length;
  }

  /**
   * 全量重算后重建 seed：用同一份 qfq 行跑一遍 calcIndicatorsStreaming，
   * 取最后 2 个交易日的 state 写入 indicator_calc_state。
   * 必要性：全量重算只刷新 daily_indicator，若不重建 seed，
   * 残留的旧 seed（可能含除权前的 raw close）会被增量路径复用，持续污染 MA。
   *
   * @remarks 刻意不与 daily_indicator 写入包装在同一事务：seed 重建失败时，
   * daily_indicator（已正确写入）不应回滚；最坏情况是下次增量走"无 seed 全量加载"
   * 路径（功能正确，仅略慢），不会比修复前更糟。
   */
  private async rebuildSeedFromFullRecalc(
    tsCode: string,
    rows: AShareQuoteForIndicator[],
  ): Promise<void> {
    if (!rows.length) return;
    const klineRows = rows.map((row): KlineRow => ({
      open_time: row.tradeDate,
      open: row.qfqOpen ?? 0,
      high: row.qfqHigh ?? 0,
      low: row.qfqLow ?? 0,
      close: row.qfqClose ?? 0,
      volume: row.vol ?? 0,
      quote_volume: row.amount ?? 0,
      qfqClose: row.qfqClose ?? 0,
    }));
    const calculated = calcIndicatorsStreaming(klineRows, null);
    const stateEntities = this.createSparseCalcStateEntities(tsCode, rows, calculated);
    await this.dataSource.query(
      'DELETE FROM raw.indicator_calc_state WHERE ts_code = $1', [tsCode],
    );
    await this.upsertInChunks(this.calcStateRepo, stateEntities, ['tsCode', 'tradeDate']);
  }

  /**
   * 全量重算后的采样对账：用独立 SQL（daily_quote.qfq_close 窗口均值）
   * 交叉验证刚写入的 MA60/MA240，防止"用错价基准"类问题再次静默写入脏数据。
   * fail-open：仅 warn 日志，不抛异常，不阻断同步主流程。
   */
  private async verifyIndicatorSample(tsCode: string, latestTradeDate: string): Promise<void> {
    const MA_AUDIT_THRESHOLD = 0.01; // 1% 偏差阈值

    try {
      const rows = await this.dataSource.query<Array<{
        stored_ma60: number | null;
        stored_ma240: number | null;
        recompute_ma60: number | null;
        recompute_ma240: number | null;
      }>>(`
        SELECT
          i.ma60 AS stored_ma60,
          i.ma240 AS stored_ma240,
          (SELECT AVG(q2.qfq_close) FROM (
            SELECT qfq_close FROM raw.daily_quote
            WHERE ts_code = $1 AND qfq_close IS NOT NULL AND trade_date <= $2
            ORDER BY trade_date DESC LIMIT 60
          ) q2) AS recompute_ma60,
          (SELECT AVG(q3.qfq_close) FROM (
            SELECT qfq_close FROM raw.daily_quote
            WHERE ts_code = $1 AND qfq_close IS NOT NULL AND trade_date <= $2
            ORDER BY trade_date DESC LIMIT 240
          ) q3) AS recompute_ma240
        FROM raw.daily_indicator i
        WHERE i.ts_code = $1 AND i.trade_date = $2
      `, [tsCode, latestTradeDate]);

      const row = rows[0];
      if (!row) return; // 该日期无 indicator 行，静默跳过

      const { stored_ma60, stored_ma240, recompute_ma60, recompute_ma240 } = row;

      // MA60 校验
      if (stored_ma60 != null && recompute_ma60 != null && recompute_ma60 !== 0) {
        const pct60 = Math.abs(stored_ma60 - recompute_ma60) / Math.abs(recompute_ma60);
        if (pct60 > MA_AUDIT_THRESHOLD) {
          this.logger.warn(
            `[indicator-audit] ${tsCode} ${latestTradeDate} MA60 偏差: stored=${stored_ma60.toFixed(4)} recompute=${recompute_ma60.toFixed(4)} diff=${(pct60 * 100).toFixed(2)}%`,
          );
        }
      }

      // MA240 校验
      if (stored_ma240 != null && recompute_ma240 != null && recompute_ma240 !== 0) {
        const pct240 = Math.abs(stored_ma240 - recompute_ma240) / Math.abs(recompute_ma240);
        if (pct240 > MA_AUDIT_THRESHOLD) {
          this.logger.warn(
            `[indicator-audit] ${tsCode} ${latestTradeDate} MA240 偏差: stored=${stored_ma240.toFixed(4)} recompute=${recompute_ma240.toFixed(4)} diff=${(pct240 * 100).toFixed(2)}%`,
          );
        }
      }
    } catch (err) {
      this.logger.debug(
        `[indicator-audit] ${tsCode} 校验跳过: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      FROM raw.daily_quote
      WHERE ts_code = $1
        ${startDate ? 'AND trade_date >= $2' : ''}
        AND qfq_open IS NOT NULL
        AND qfq_high IS NOT NULL
        AND qfq_low IS NOT NULL
        AND qfq_close IS NOT NULL
      ORDER BY trade_date ASC
    `, params);
  }

  private async loadQuoteRowsAfter(tsCode: string, afterDate: string): Promise<AShareQuoteForIndicator[]> {
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
      FROM raw.daily_quote
      WHERE ts_code = $1
        AND trade_date > $2
        AND qfq_open IS NOT NULL
        AND qfq_high IS NOT NULL
        AND qfq_low IS NOT NULL
        AND qfq_close IS NOT NULL
      ORDER BY trade_date ASC
    `, [tsCode, afterDate]);
  }

  private async repairSeedSignedAmounts(
    tsCode: string,
    seedTradeDate: string,
    seed: IndicatorCalcState,
  ): Promise<IndicatorCalcState> {
    const historyRows = await this.loadQuoteRowsBefore(tsCode, seedTradeDate, 21);
    if (historyRows.length < 5) return seed;
    const klineRows = historyRows.map((row): KlineRow => ({
      open_time: row.tradeDate,
      open: row.qfqOpen ?? 0,
      high: row.qfqHigh ?? 0,
      low: row.qfqLow ?? 0,
      close: row.qfqClose ?? 0,
      volume: row.vol ?? 0,
      quote_volume: row.amount ?? 0,
      qfqClose: row.qfqClose ?? 0,
    }));
    const historyCalc = calcIndicatorsStreaming(klineRows);
    const lastState = historyCalc[historyCalc.length - 1].state;
    if (lastState && lastState.signedAmounts.length > 0) {
      seed.signedAmounts = lastState.signedAmounts;
    }
    return seed;
  }

  private async loadQuoteRowsBefore(
    tsCode: string,
    beforeDate: string,
    limit: number,
  ): Promise<AShareQuoteForIndicator[]> {
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
      FROM raw.daily_quote
      WHERE ts_code = $1
        AND trade_date <= $2
        AND qfq_open IS NOT NULL
        AND qfq_high IS NOT NULL
        AND qfq_low IS NOT NULL
        AND qfq_close IS NOT NULL
      ORDER BY trade_date DESC
      LIMIT $3
    `, [tsCode, beforeDate, limit]);
    return rows.reverse();
  }

  private createIndicatorEntity(
    tsCode: string,
    tradeDate: string,
    row: KlineRowWithIndicators,
    brickChart: { brick: number; delta: number; xg: boolean } | null,
  ): DailyIndicatorEntity {
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
      roc10: row.roc10,
      roc20: row.roc20,
      roc60: row.roc60,
      obv5d: row.obv5d,
      obv10d: row.obv10d,
      obv20d: row.obv20d,
      vwap5: row.vwap5,
      vwap10: row.vwap10,
      vwap20: row.vwap20,
    });
  }

  private createSparseCalcStateEntities(
    tsCode: string,
    rows: AShareQuoteForIndicator[],
    calculated: Awaited<ReturnType<IndicatorWorkerPool['run']>>,
  ): IndicatorCalcStateEntity[] {
    const indexes = new Set<number>();
    indexes.add(rows.length - 1);
    if (rows.length > 1) indexes.add(rows.length - 2);

    return [...indexes].sort((a, b) => a - b).map((index) => this.calcStateRepo.create({
      tsCode,
      tradeDate: rows[index].tradeDate,
      state: calculated[index].state as unknown as Record<string, unknown>,
    }));
  }

  private async upsertInChunks<Entity extends object>(
    repo: Repository<Entity>,
    entities: Entity[],
    conflictPaths: string[],
  ): Promise<void> {
    const map = new Map<string, Entity>();
    for (const entity of entities) {
      const key = conflictPaths
        .map((p) => String((entity as Record<string, unknown>)[p]))
        .join('|');
      map.set(key, entity);
    }
    const deduped = Array.from(map.values());

    const chunkSize = 1000;
    for (let index = 0; index < deduped.length; index += chunkSize) {
      await repo.upsert(deduped.slice(index, index + chunkSize), conflictPaths);
    }
  }

  private async insertInChunks<Entity extends object>(
    repo: Repository<Entity>,
    entities: Entity[],
  ): Promise<void> {
    const chunkSize = 1000;
    for (let index = 0; index < entities.length; index += chunkSize) {
      await repo.insert(entities.slice(index, index + chunkSize));
    }
  }
}
