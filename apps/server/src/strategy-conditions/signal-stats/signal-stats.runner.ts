/**
 * signal-stats.runner.ts
 *
 * 异步编排：枚举买入信号 → 逐笔模拟出场 → 聚合指标 → 落库。
 * 由 SignalStatsService.run() 触发，立即返回 runId，本方法异步执行。
 *
 * 编排流程：
 *   1. enumerator.listSseTradingDays → progressTotal（初始化进度）。
 *   2. enumerator.enumerateSignals 逐日枚举买入信号（onProgress 回调更新 progress_scanned）。
 *   3. 预取全局 SSE 日历（enumerator.listAllSseTradingDays），simulateSignalsBatched 共享复用。
 *   4. 批量调 SignalStatsSimulator.simulateSignalsBatched → SimulationOutcome[]（按 tsCode 分组预取 + 内存切窗 + 有界并发）。
 *   5. 从 trades 提取 ret[]/holdDays[] 调 calcSignalStats 聚合。
 *   6. 落库：先批量插入 signal_test_trade，再更新 run（completed + 指标 + filteredCount）——
 *      顺序保证 completed ⇔ 全量 trade 已落库（防详情早读部分数据 / 插入失败翻 failed）。
 *   异常 → run.status='failed' + error_message（不静默吞）。
 *   空数据（0 信号 / 全被过滤）→ run 仍 completed，sampleCount=0，filteredCount 正常填充。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SignalTestRunEntity } from '../../entities/strategy/signal-test-run.entity';
import { SignalTestTradeEntity } from '../../entities/strategy/signal-test-trade.entity';
import { SignalTestEntity } from '../../entities/strategy/signal-test.entity';
import { SignalStatsEnumerator } from './signal-stats.enumerator';
import { SignalStatsSimulator } from './signal-stats.simulator.db';
import { calcSignalStats } from './signal-stats.metrics';
import { SimulatedTrade, FilterReason } from './signal-stats.simulator';
import { ExitConfig } from './signal-stats.simulator';

/** 按 FilterReason 分组的过滤计数。 */
interface FilterCounts {
  suspended: number;
  limit_up: number;
  new_listing: number;
  insufficient_data: number;
}

@Injectable()
export class SignalStatsRunner {
  private readonly logger = new Logger(SignalStatsRunner.name);

  constructor(
    @InjectRepository(SignalTestRunEntity)
    private readonly runRepo: Repository<SignalTestRunEntity>,
    @InjectRepository(SignalTestTradeEntity)
    private readonly tradeRepo: Repository<SignalTestTradeEntity>,
    private readonly enumerator: SignalStatsEnumerator,
    private readonly simulator: SignalStatsSimulator,
  ) {}

  /**
   * 每个阶段一个节流封装。
   * bump(n) 仅记内存；start() 起 ~1.5s 节流 flush；stop() 清 timer + 最终矫正。
   */
  private makePhaseProgress(runId: string, intervalMs = 1500) {
    let current = 0;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const flush = async () => {
      if (inFlight) return; // 防上一个 update 未完又起
      inFlight = true;
      try {
        await this.runRepo.update(runId, { progressScanned: current });
      } finally {
        inFlight = false;
      }
    };
    return {
      bump: (n: number) => {
        current += n;
      },
      start: () => {
        timer = setInterval(() => {
          void flush();
        }, intervalMs);
      },
      stop: async () => {
        if (timer) clearInterval(timer);
        await this.runRepo.update(runId, { progressScanned: current });
      },
    };
  }

  /**
   * 执行一次完整的信号前向统计 run。
   * 由 service 通过 `.catch(err => logger.error(...))` 包装后异步调用，
   * 内部不抛出——异常直接写入 run.errorMessage。
   */
  async executeRun(test: SignalTestEntity, runId: string): Promise<void> {
    try {
      await this.doExecute(test, runId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`SignalStatsRun ${runId} failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      // 清理可能已落库的半截逐笔明细：insert 排在标 completed 之前，若插入中途失败会残留
      // 部分 trade，删除避免 failed run 仍挂着部分明细误导详情。清理失败不得掩盖原始错误。
      try {
        await this.tradeRepo.delete({ runId });
      } catch (cleanupErr: unknown) {
        const cmsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.error(`SignalStatsRun ${runId} 清理半截 trade 失败: ${cmsg}`);
      }
      await this.runRepo.update(runId, {
        status: 'failed',
        errorMessage: msg,
      });
    }
  }

  private async doExecute(test: SignalTestEntity, runId: string): Promise<void> {
    const { buyConditions, exitMode, horizonN, exitConditions, maxHold, bandLockParams, universe, dateStart, dateEnd } = test;

    // ── 1. 初始化 progressTotal（区间 SSE 交易日数）
    const tradingDays = await this.enumerator.listSseTradingDays(dateStart, dateEnd);
    const total = tradingDays.length;
    await this.runRepo.update(runId, { progressTotal: total });
    await this.runRepo.update(runId, { phase: 'scanning' });

    if (total === 0) {
      this.logger.warn(`SignalStatsRun ${runId}: no SSE trading days in [${dateStart}, ${dateEnd}]`);
      await this.runRepo.update(runId, {
        status: 'completed',
        sampleCount: 0,
        filteredCount: 0,
        completedAt: new Date(),
      });
      return;
    }

    // ── 2. 预取全局 SSE 日历（simulateSignalsBatched 共享，避免每信号重查）
    const sseCalendar = await this.enumerator.listAllSseTradingDays();

    // ── 3. 枚举买入信号，逐日更新 progress_scanned
    const signals = await this.enumerator.enumerateSignals(
      buyConditions,
      dateStart,
      dateEnd,
      universe,
      async (scanned: number, _total: number) => {
        await this.runRepo.update(runId, { progressScanned: scanned });
      },
    );

    if (signals.length === 0) {
      this.logger.warn(`SignalStatsRun ${runId} (testId=${test.id}): 0 buy signals in [${dateStart}, ${dateEnd}]`);
      await this.runRepo.update(runId, {
        status: 'completed',
        progressScanned: total,
        sampleCount: 0,
        filteredCount: 0,
        completedAt: new Date(),
      });
      return;
    }

    // ── 4. 构造 exit 配置
    //   trailing_lock 必须在 strategy 之前显式分支：否则会落进 {mode:'strategy', maxHold: maxHold!}
    //   导致行为错乱（trailing_lock 的 maxHold 可空、且走的是 decideBandLock 而非 decideStrategy）。
    let exit: ExitConfig;
    if (exitMode === 'fixed_n') {
      exit = { mode: 'fixed_n', horizonN: horizonN! };
    } else if (exitMode === 'trailing_lock') {
      // maxHold 可选（留空=无硬上限）；null/undefined 统一收敛为 undefined。
      // band_lock 4 参数从 bandLockParams（已是量化后的网格点 ratio）透传；null → 各自默认。
      exit = {
        mode: 'trailing_lock',
        maxHold: maxHold ?? undefined,
        stopRatio: bandLockParams?.stopRatio ?? 0.999,
        floorRatio: bandLockParams?.floorRatio ?? 0.999,
        floorEnabled: bandLockParams?.floorEnabled ?? true,
        ma5RequireDown: bandLockParams?.ma5RequireDown ?? true,
      };
    } else {
      exit = { mode: 'strategy', maxHold: maxHold! };
    }

    // ── 5. 批量模拟出场（按 tsCode 分组预取 + 内存切窗 + 有界并发）
    await this.runRepo.update(runId, { phase: 'simulating', progressTotal: signals.length, progressScanned: 0 });
    const sim = this.makePhaseProgress(runId);
    sim.start();
    let outcomes: Awaited<ReturnType<typeof this.simulator.simulateSignalsBatched>>;
    try {
      outcomes = await this.simulator.simulateSignalsBatched({
        signals,
        exit,
        exitConditions: exitMode === 'strategy' ? (exitConditions ?? []) : null,
        sseCalendar,
        dateEnd,
        onGroupDone: (groupSize) => sim.bump(groupSize),
        // 买入条件显式含上市时长（list_days）→ 跳过次新硬过滤，以用户条件为准
        skipNewListingFilter: buyConditions.some((c) => c.field === 'list_days'),
      });
    } finally {
      await sim.stop(); // 清 timer + 最终矫正到 signals.length
    }

    const trades: SimulatedTrade[] = [];
    const filterCounts: FilterCounts = { suspended: 0, limit_up: 0, new_listing: 0, insufficient_data: 0 };

    for (const outcome of outcomes) {
      if (outcome.kind === 'trade') {
        trades.push(outcome.trade);
      } else {
        const reason = outcome.reason as FilterReason;
        filterCounts[reason] = (filterCounts[reason] ?? 0) + 1;
      }
    }

    const filteredCount = filterCounts.suspended + filterCounts.limit_up + filterCounts.new_listing + filterCounts.insufficient_data;

    if (trades.length === 0 && filteredCount > 0) {
      this.logger.warn(
        `SignalStatsRun ${runId}: all ${filteredCount} signals filtered ` +
        `(suspended=${filterCounts.suspended}, limit_up=${filterCounts.limit_up}, ` +
        `new_listing=${filterCounts.new_listing}, insufficient_data=${filterCounts.insufficient_data})`,
      );
    }

    // ── 6. 聚合指标
    const rets = trades.map((t) => t.ret);
    const holdDays = trades.map((t) => t.holdDays);
    const stats = calcSignalStats(rets, holdDays);

    // ── 7. 先批量插入逐笔明细（分批避免超大 SQL）
    //     必须排在「标 completed」之前：让 completed 严格意味着「全量 trade 已落库」。
    //     否则详情 / ret-histogram 接口会在插入未完时现读到部分数据；且插入中途失败
    //     会把已 completed 的 run 翻成 failed。插入未完期间 run 仍 running，状态更诚实。
    if (trades.length > 0) {
      await this.runRepo.update(runId, { phase: 'writing', progressTotal: trades.length, progressScanned: 0 });
      await this.insertTradesBatched(runId, trades);
    }

    // ── 8. 落库：更新 run 为 completed + 聚合指标（numeric 列以 string 存，对齐实体约定）
    const numStr = (v: number | null): string | null => (v === null ? null : String(v));
    await this.runRepo.update(runId, {
      status: 'completed',
      progressScanned: total,
      sampleCount: stats.sampleCount,
      winRate: numStr(stats.winRate),
      avgWin: numStr(stats.avgWin),
      avgLoss: numStr(stats.avgLoss),
      payoffRatio: numStr(stats.payoffRatio),
      profitFactor: numStr(stats.profitFactor),
      kellyF: numStr(stats.kellyF),
      avgHoldDays: numStr(stats.avgHoldDays),
      worstTradeRet: numStr(stats.worstTradeRet),
      bestTradeRet: numStr(stats.bestTradeRet),
      filteredCount,
      completedAt: new Date(),
    });

    this.logger.log(
      `SignalStatsRun ${runId} completed: signals=${signals.length}, trades=${trades.length}, ` +
      `filtered=${filteredCount}, winRate=${stats.winRate?.toFixed(4) ?? 'null'}`,
    );
  }

  /** 分批插入 signal_test_trade，每批 200 条避免 SQL 过长；每 FLUSH_EVERY 批上报进度。 */
  private async insertTradesBatched(runId: string, trades: SimulatedTrade[]): Promise<void> {
    const BATCH = 200;
    const FLUSH_EVERY = 10; // 每 2000 行 flush 一次
    let written = 0;
    let batchNo = 0;
    for (let i = 0; i < trades.length; i += BATCH) {
      const slice = trades.slice(i, i + BATCH);
      const entities = slice.map((t) =>
        this.tradeRepo.create({
          runId,
          tsCode: t.tsCode,
          signalDate: t.signalDate,
          buyDate: t.buyDate,
          exitDate: t.exitDate,
          buyPrice: String(t.buyPrice),
          exitPrice: String(t.exitPrice),
          ret: String(t.ret),
          holdDays: t.holdDays,
          exitReason: t.exitReason,
        }),
      );
      await this.tradeRepo.save(entities);
      written += slice.length;
      if (++batchNo % FLUSH_EVERY === 0) {
        await this.runRepo.update(runId, { progressScanned: written });
      }
    }
    // 末批矫正：确保最终值等于实际写入数
    await this.runRepo.update(runId, { progressScanned: written });
  }
}
