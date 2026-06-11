/**
 * portfolio-sim.runner.ts
 *
 * 组合模拟异步编排：装载 → 引擎回放 → 落库 → 锚点对账 → 汇总指标写回。
 * 由 PortfolioSimService.triggerRun 通过 `.catch(logger.error)` 包装后异步调用，立即返回 runId。
 *
 * 三阶段进度（写 run 行 phase + progress_done/progress_total，每阶段重置 progress_total）：
 *   1. loading   —— progress = tsCode 行情组完成数 / 总组数（loader onGroupDone 回调）。
 *   2. replaying —— progress = 已回放交易日数 / 总交易日数（引擎 onProgress 回调，节流上报）。
 *   3. writing   —— progress = 已写批次 / 总批次（daily + fills 分批 insert，批 1000）。
 *
 * 幂等：执行起点事务内 DELETE 该 run_id 旧 daily/fills（重跑覆盖）。
 * 完成必须推满进度（progress_done=progress_total）再置 status='success'（仓内血泪教训：
 *   完成不发终态进度让前端卡 99%）。
 * 任何异常 → status='failed' + error_message（中文可读）+ logger.error 带 runId。
 *
 * 锚点对账（config.anchorMode=true，DTO 已校验单源）：回放完取该源全部 taken fills 的
 *   realizedRetNet + holdDays 喂 calcSignalStats，与官方 signal_test_run 行的
 *   kelly_f/win_rate/sample_count 对账，写 anchor_check jsonb。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PortfolioSimRunEntity, PortfolioSimAnchorCheck } from '../../entities/strategy/portfolio-sim-run.entity';
import { PortfolioSimDailyEntity } from '../../entities/strategy/portfolio-sim-daily.entity';
import { PortfolioSimFillEntity } from '../../entities/strategy/portfolio-sim-fill.entity';
import { calcSignalStats } from '../signal-stats/signal-stats.metrics';
import { runPortfolioSim } from './portfolio-sim.engine';
import { PortfolioSimLoader } from './portfolio-sim.loader';
import { parseNumericString } from './portfolio-sim.loader-helpers';
import {
  EngineFill,
  EngineResult,
  PortfolioSimConfig,
} from './portfolio-sim.types';

/** daily / fills 批量 insert 批大小。 */
export const WRITE_BATCH = 1000;
/** replaying 阶段进度节流间隔（ms）。 */
const REPLAY_FLUSH_INTERVAL_MS = 1500;
/** 锚点对账容差。 */
export const ANCHOR_EPS = 1e-9;

@Injectable()
export class PortfolioSimRunner {
  private readonly logger = new Logger(PortfolioSimRunner.name);

  constructor(
    @InjectRepository(PortfolioSimRunEntity)
    private readonly runRepo: Repository<PortfolioSimRunEntity>,
    @InjectRepository(PortfolioSimDailyEntity)
    private readonly dailyRepo: Repository<PortfolioSimDailyEntity>,
    @InjectRepository(PortfolioSimFillEntity)
    private readonly fillRepo: Repository<PortfolioSimFillEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly loader: PortfolioSimLoader,
  ) {}

  /**
   * 执行一次完整组合模拟。内部不抛出——异常写入 run.error_message + status='failed'。
   */
  async executeRun(runId: string): Promise<void> {
    try {
      await this.doExecute(runId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `PortfolioSimRun ${runId} 失败: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      // 清理可能已落库的半截 daily/fills，避免 failed run 仍挂部分数据误导。
      try {
        await this.dailyRepo.delete({ runId });
        await this.fillRepo.delete({ runId });
      } catch (cleanupErr: unknown) {
        const cmsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.error(`PortfolioSimRun ${runId} 清理半截数据失败: ${cmsg}`);
      }
      await this.runRepo.update(runId, { status: 'failed', errorMessage: msg });
    }
  }

  private async doExecute(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new Error(`组合模拟 run ${runId} 不存在`);
    const config = run.config as unknown as PortfolioSimConfig;

    // ── 幂等：事务内删旧 daily/fills（重跑覆盖）。
    await this.dataSource.transaction(async (mgr) => {
      await mgr.delete(PortfolioSimDailyEntity, { runId });
      await mgr.delete(PortfolioSimFillEntity, { runId });
    });

    // ── 阶段 1：loading（装载 trades + rank + qfq 行情 + 日历）。
    await this.runRepo.update(runId, {
      phase: 'loading',
      progressDone: 0,
      progressTotal: 0,
    });
    const loaded = await this.loader.load(config, (done) => {
      // 纯内存回调；行情组完成数即 loading 进度（节流：每组都 update 会过密，按 done 直写但量级小）。
      void this.runRepo.update(runId, { progressDone: done });
    });
    await this.runRepo.update(runId, { progressTotal: loaded.groupTotal, progressDone: loaded.groupTotal });

    // ── 阶段 2：replaying（引擎逐日回放，onProgress 节流上报）。
    const totalDays = loaded.input.calendar.length;
    await this.runRepo.update(runId, {
      phase: 'replaying',
      progressTotal: totalDays,
      progressDone: 0,
    });
    const replayProgress = this.makeThrottledProgress(runId);
    replayProgress.start();
    let result: EngineResult;
    try {
      result = runPortfolioSim(loaded.input, (done) => replayProgress.set(done));
    } finally {
      await replayProgress.stop(totalDays);
    }

    // ── 阶段 3：writing（daily + fills 分批 insert）。
    await this.writeResults(runId, config, result);

    // ── 锚点对账（anchorMode）。
    let anchorCheck: PortfolioSimAnchorCheck | null = null;
    if (config.anchorMode) {
      anchorCheck = await this.runAnchorCheck(config, result);
    }

    // ── 汇总指标写回 + 终态（progress_done=progress_total 已在 writeResults 末尾推满）。
    const s = result.summary;
    const numStr = (v: number | null): string | null => (v === null ? null : String(v));
    await this.runRepo.update(runId, {
      status: 'success',
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
      anchorCheck,
      completedAt: new Date(),
    });

    this.logger.log(
      `PortfolioSimRun ${runId} 完成: days=${totalDays}, taken=${s.nTaken}, ` +
        `skipped=${s.nSkipped}, finalNav=${s.finalNav.toFixed(2)}` +
        (anchorCheck ? `, anchorPass=${anchorCheck.pass}` : ''),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 写库：daily + fills
  // ──────────────────────────────────────────────────────────────────────────

  /** daily + fills 分批 insert，进度按已写批次 / 总批次。完成推满 progress。 */
  private async writeResults(
    runId: string,
    config: PortfolioSimConfig,
    result: EngineResult,
  ): Promise<void> {
    const dailyRows = result.dailyRows;
    const fills = result.fills;
    const totalBatches =
      Math.ceil(dailyRows.length / WRITE_BATCH) + Math.ceil(fills.length / WRITE_BATCH);

    await this.runRepo.update(runId, {
      phase: 'writing',
      progressTotal: Math.max(totalBatches, 1),
      progressDone: 0,
    });

    let batchNo = 0;

    // daily
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
          strategyExposure: r.strategyExposure,
        }),
      );
      await this.dailyRepo.save(entities);
      batchNo += 1;
      await this.runRepo.update(runId, { progressDone: batchNo });
    }

    // fills（sourceIdx → source_run_id / source_label / rank_field 由 config 解析）。
    for (let i = 0; i < fills.length; i += WRITE_BATCH) {
      const slice = fills.slice(i, i + WRITE_BATCH);
      const entities = slice.map((f) => this.toFillEntity(runId, config, f));
      await this.fillRepo.save(entities);
      batchNo += 1;
      await this.runRepo.update(runId, { progressDone: batchNo });
    }

    // 推满进度（防前端卡 99%）。
    await this.runRepo.update(runId, { progressDone: Math.max(totalBatches, 1) });
  }

  /** EngineFill → PortfolioSimFillEntity（解析 source 元信息 + numeric→string）。 */
  private toFillEntity(
    runId: string,
    config: PortfolioSimConfig,
    f: EngineFill,
  ): PortfolioSimFillEntity {
    const source = config.sources[f.sourceIdx];
    const numStr = (v: number | null | undefined): string | null =>
      v === null || v === undefined ? null : String(v);
    return this.fillRepo.create({
      runId,
      sourceRunId: source.runId,
      sourceLabel: source.label,
      tsCode: f.tsCode,
      signalDate: f.signalDate,
      buyDate: f.buyDate,
      status: f.status,
      skipReason: f.skipReason ?? null,
      rankField: source.rankField === 'none' ? null : source.rankField,
      rankValue: numStr(f.rankValue),
      weightEntry: numStr(f.weightEntry),
      alloc: numStr(f.alloc),
      exitDate: f.exitDate ?? null,
      realizedRetNet: numStr(f.realizedRetNet),
      costsPaid: numStr(f.costsPaid),
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 锚点对账
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 锚点对账：单源回放结果（taken fills 的 realizedRetNet/holdDays）喂 calcSignalStats，
   * 与官方 signal_test_run 行（该源 runId）的 kelly_f/win_rate/sample_count 对账。
   *
   * pass = |kelly差|<EPS 且 |win差|<EPS 且 n 完全相等。
   * holdDays：fills 不携带 holdDays，从该源 trades（loader 已载 EngineTrade.holdDays）取——
   *   但 calcSignalStats 的 kelly/win 仅依赖 rets，holdDays 只影响 avgHoldDays（不参与对账），
   *   故此处用统一占位 1 即可，不影响 kelly/win/n 三项对账。
   */
  private async runAnchorCheck(
    config: PortfolioSimConfig,
    result: EngineResult,
  ): Promise<PortfolioSimAnchorCheck> {
    const sourceRunId = config.sources[0].runId; // anchorMode 已校验单源
    const takenRets = result.fills
      .filter((f) => f.status === 'taken' && f.realizedRetNet !== undefined)
      .map((f) => f.realizedRetNet as number);
    const replayed = calcSignalStats(takenRets, takenRets.map(() => 1));

    const rows = await this.dataSource.query<
      Array<{ kelly_f: string | null; win_rate: string | null; sample_count: number | null }>
    >(
      `SELECT kelly_f, win_rate, sample_count
         FROM signal_test_run
        WHERE id = $1`,
      [sourceRunId],
    );
    const official = rows[0] ?? { kelly_f: null, win_rate: null, sample_count: null };
    const kellyOfficial = parseNumericString(official.kelly_f) ?? 0;
    const winOfficial = parseNumericString(official.win_rate) ?? 0;
    const nOfficial = official.sample_count ?? 0;

    const kellyReplayed = replayed.kellyF ?? 0;
    const winReplayed = replayed.winRate ?? 0;
    const nReplayed = replayed.sampleCount;

    const pass =
      Math.abs(kellyOfficial - kellyReplayed) < ANCHOR_EPS &&
      Math.abs(winOfficial - winReplayed) < ANCHOR_EPS &&
      nOfficial === nReplayed;

    return {
      pass,
      kellyOfficial,
      kellyReplayed,
      winOfficial,
      winReplayed,
      nOfficial,
      nReplayed,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 进度节流（replaying 阶段）
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 节流进度上报：set(n) 仅记内存；start() 起 ~1.5s 节流 flush；stop(final) 清 timer + 最终矫正。
   * （引擎 onProgress 同步密集回调，不可每次 await DB——照搬 signal-stats.runner.makePhaseProgress。）
   */
  private makeThrottledProgress(runId: string, intervalMs = REPLAY_FLUSH_INTERVAL_MS) {
    let current = 0;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const flush = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await this.runRepo.update(runId, { progressDone: current });
      } finally {
        inFlight = false;
      }
    };
    return {
      set: (n: number) => {
        current = n;
      },
      start: () => {
        timer = setInterval(() => {
          void flush();
        }, intervalMs);
      },
      stop: async (final: number) => {
        if (timer) clearInterval(timer);
        await this.runRepo.update(runId, { progressDone: final });
      },
    };
  }
}
