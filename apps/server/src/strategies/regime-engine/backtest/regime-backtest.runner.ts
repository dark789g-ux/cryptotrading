import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { RegimeBacktestRunEntity } from '../../../entities/strategy/regime-backtest-run.entity';
import { RegimeBacktestDailyEntity } from '../../../entities/strategy/regime-backtest-daily.entity';
import { RegimeBacktestTradeEntity } from '../../../entities/strategy/regime-backtest-trade.entity';
import { RegimeBacktestDataLoader } from './regime-backtest.data-loader';
import { runRegimeBacktest } from './regime-backtest.engine';
import { RegimeBacktestCapital } from './regime-backtest.types';
import { mergeRankAudit } from './rank-audit-merge';

const WRITE_BATCH = 500;

@Injectable()
export class RegimeBacktestRunner {
  private readonly logger = new Logger(RegimeBacktestRunner.name);

  constructor(
    @InjectRepository(RegimeBacktestRunEntity)
    private readonly runRepo: Repository<RegimeBacktestRunEntity>,
    @InjectRepository(RegimeBacktestDailyEntity)
    private readonly dailyRepo: Repository<RegimeBacktestDailyEntity>,
    @InjectRepository(RegimeBacktestTradeEntity)
    private readonly tradeRepo: Repository<RegimeBacktestTradeEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly dataLoader: RegimeBacktestDataLoader,
  ) {}

  async executeRun(runId: string): Promise<void> {
    try {
      await this.doExecute(runId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `RegimeBacktestRun ${runId} failed: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      try {
        await this.dailyRepo.delete({ runId });
        await this.tradeRepo.delete({ runId });
      } catch (cleanupErr: unknown) {
        const cmsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.error(`RegimeBacktestRun ${runId} cleanup failed: ${cmsg}`);
      }
      await this.runRepo.update(runId, { status: 'failed', errorMessage: msg });
    }
  }

  private async doExecute(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new Error(`RegimeBacktestRun ${runId} not found`);

    const regimeConfig = run.config as Record<string, unknown>;
    const capital = (regimeConfig.capital ?? {}) as RegimeBacktestCapital;
    const dateStart = run.dateStart;
    const dateEnd = run.dateEnd;

    await this.dataSource.transaction(async (mgr) => {
      await mgr.delete(RegimeBacktestDailyEntity, { runId });
      await mgr.delete(RegimeBacktestTradeEntity, { runId });
    });

    await this.runRepo.update(runId, {
      phase: 'loading',
      progressDone: 0,
      progressTotal: 0,
    });

    const { input, rankedAll } = await this.dataLoader.load({
      regimeConfig: regimeConfig.config as any,
      capital,
      dateStart,
      dateEnd,
    });

    await this.runRepo.update(runId, { progressTotal: input.calendar.length, progressDone: input.calendar.length });

    const totalDays = input.calendar.length;
    await this.runRepo.update(runId, {
      phase: 'replaying',
      progressTotal: totalDays,
      progressDone: 0,
    });

    const result = runRegimeBacktest(input);
    const { trades, extraSkipped } = mergeRankAudit(result.trades, rankedAll);
    result.trades = trades;
    result.summary.nSkipped += extraSkipped;

    await this.runRepo.update(runId, { progressDone: totalDays });

    await this.writeResults(runId, result);

    const s = result.summary;
    const numStr = (v: number | null): string | null => (v === null ? null : String(v));
    await this.runRepo.update(runId, {
      status: 'completed',
      phase: 'writing',
      finalNav: numStr(s.finalNav),
      totalRet: numStr(s.totalRet),
      annualRet: numStr(s.annualRet),
      maxDrawdown: numStr(s.maxDrawdown),
      sharpe: numStr(s.sharpe),
      calmar: numStr(s.calmar),
      dailyWinRate: numStr(s.dailyWinRate),
      dailyKelly: numStr(s.dailyKelly),
      nTaken: s.nTaken,
      nSkipped: s.nSkipped,
      totalCosts: numStr(s.totalCosts),
      progressDone: result.dailyRows.length,
      progressTotal: result.dailyRows.length,
      completedAt: new Date(),
    });

    this.logger.log(
      `RegimeBacktestRun ${runId} done: days=${totalDays}, taken=${s.nTaken}, skipped=${s.nSkipped}, finalNav=${s.finalNav.toFixed(2)}`,
    );
  }

  private async writeResults(
    runId: string,
    result: ReturnType<typeof runRegimeBacktest>,
  ): Promise<void> {
    const dailyRows = result.dailyRows;
    const trades = result.trades;
    const totalBatches =
      Math.ceil(dailyRows.length / WRITE_BATCH) +
      Math.ceil(trades.length / WRITE_BATCH);

    await this.runRepo.update(runId, {
      phase: 'writing',
      progressTotal: Math.max(totalBatches, 1),
      progressDone: 0,
    });

    let batchNo = 0;
    const numStr = (v: number | null | undefined): string | null =>
      v === null || v === undefined ? null : String(v);

    for (let i = 0; i < dailyRows.length; i += WRITE_BATCH) {
      const slice = dailyRows.slice(i, i + WRITE_BATCH);
      const entities = slice.map((r) =>
        this.dailyRepo.create({
          runId,
          tradeDate: r.tradeDate,
          nav: String(r.nav),
          cash: String(r.cash),
          dailyRet: String(r.dailyRet),
          exposure: String(r.exposure),
          positionCount: r.positionCount,
        }),
      );
      await this.dailyRepo.save(entities);
      batchNo++;
      await this.runRepo.update(runId, { progressDone: batchNo });
    }

    for (let i = 0; i < trades.length; i += WRITE_BATCH) {
      const slice = trades.slice(i, i + WRITE_BATCH);
      const entities = slice.map((t) =>
        this.tradeRepo.create({
          runId,
          signalDate: t.signalDate,
          buyDate: t.buyDate,
          exitDate: t.exitDate ?? null,
          tsCode: t.tsCode,
          regime: t.regime,
          exitMode: t.exitMode,
          status: t.status,
          skipReason: t.skipReason ?? null,
          exitReason: t.exitReason ?? null,
          ret: numStr(t.ret),
          alloc: numStr(t.alloc),
          costsPaid: numStr(t.costsPaid),
          realizedRetNet: numStr(t.realizedRetNet),
          rank: t.rank ?? null,
          rankField: t.rankField ?? null,
          rankValue: numStr(t.rankValue),
        }),
      );
      await this.tradeRepo.save(entities);
      batchNo++;
      await this.runRepo.update(runId, { progressDone: batchNo });
    }

    await this.runRepo.update(runId, { progressDone: Math.max(totalBatches, 1) });
  }
}
