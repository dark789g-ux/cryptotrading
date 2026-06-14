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
import { SignalTestEquityEntity } from '../../entities/strategy/signal-test-equity.entity';
import {
  SignalTestEntity,
  SignalTestBacktestConfig,
} from '../../entities/strategy/signal-test.entity';
import { SignalStatsEnumerator } from './signal-stats.enumerator';
import { SignalStatsSimulator } from './signal-stats.simulator.db';
import { calcSignalStats } from './signal-stats.metrics';
import { SimulatedTrade, FilterReason } from './signal-stats.simulator';
import { ExitConfig } from './signal-stats.simulator';
import { PortfolioSimLoader } from '../portfolio-sim/portfolio-sim.loader';
import { runPortfolioSim } from '../portfolio-sim/portfolio-sim.engine';
import {
  EngineDailyRow,
  EngineSummary,
  PortfolioSimConfig,
} from '../portfolio-sim/portfolio-sim.types';

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
    @InjectRepository(SignalTestEquityEntity)
    private readonly equityRepo: Repository<SignalTestEquityEntity>,
    private readonly enumerator: SignalStatsEnumerator,
    private readonly simulator: SignalStatsSimulator,
    private readonly portfolioSimLoader: PortfolioSimLoader,
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
    const { buyConditions, exitMode, horizonN, exitConditions, maxHold, bandLockParams, phaseLockParams, universe, dateStart, dateEnd } = test;

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
    //   trailing_lock / phase_lock 必须在 strategy 之前显式分支：否则会落进 {mode:'strategy', maxHold: maxHold!}
    //   导致行为错乱（trailing_lock/phase_lock 的 maxHold 可空、且走各自 decideXxx 而非 decideStrategy）。
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
    } else if (exitMode === 'phase_lock') {
      // phase_lock 3 参数从 phaseLockParams（已是量化后的网格点）透传；null → 各自默认（0.999/0.999/10）。
      exit = {
        mode: 'phase_lock',
        initFactor: phaseLockParams?.initFactor ?? 0.999,
        lockFactor: phaseLockParams?.lockFactor ?? 0.999,
        lookback: phaseLockParams?.lookback ?? 10,
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

    // 是否需要跑资金账户层（圈码 ⑤⑥⑦）：backtest_config != null 且有逐笔可回放。
    const runBacktest = !!test.backtestConfig && trades.length > 0;

    // ── 8. 落库：信号质量层聚合指标（numeric 列以 string 存，对齐实体约定）。
    //     圈码顺序（spec 02 §2.1 / 04 §4.2）：⑧ status='completed' 必须排在 ⑤⑥⑦ 之后，
    //     使「completed」严格意味着「连回测层（equity + 回测列）也已落库」——否则前端轮询
    //     可能在 replaying/writing 中途见到 completed 而过早判定"无回测视图"。
    //     · 无回测层：本次 update 直接含 status='completed'（与今日逐字一致，零漂移）。
    //     · 有回测层：本次 update 不含 status（仍 running），跑完 ⑤⑥⑦ 后再单独标 completed。
    const numStr = (v: number | null): string | null => (v === null ? null : String(v));
    await this.runRepo.update(runId, {
      ...(runBacktest ? {} : { status: 'completed' as const }),
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

    // ── 资金账户层（迷你回测，圈码 ⑤⑥⑦）：独立 try/catch（spec 04 §4.3），
    //     失败绝不冒泡到 executeRun 顶层 catch（否则会删掉质量层已落库的 trade）。
    if (runBacktest) {
      await this.runBacktestLayer(test.backtestConfig!, runId);
      // ⑧ 终态：质量层 + 回测层均已落库后才标 completed（回测层失败也照常 completed，
      //    其 catch 内已置回测列 null + error_message，质量数据保留）。
      await this.runRepo.update(runId, { status: 'completed' });
    }

    this.logger.log(
      `SignalStatsRun ${runId} completed: signals=${signals.length}, trades=${trades.length}, ` +
      `filtered=${filteredCount}, winRate=${stats.winRate?.toFixed(4) ?? 'null'}`,
    );
  }

  /**
   * 资金账户层（迷你回测）：复用 portfolio-sim loader + 引擎按 run_id 回放刚落库的逐笔交易。
   *
   * 圈码 ⑤ 构造单源 PortfolioSimConfig → loader.load → EngineInput；
   *      ⑥ runPortfolioSim → EngineResult（phase='replaying'，onProgress 上报）；
   *      ⑦ phase='writing'：DELETE equity（幂等）→ 批量 insert dailyRows → UPDATE run 11 回测列。
   *
   * 错误边界（spec 04 §4.3）：任一步抛错 → logger.error + 回测 11 列置 null + error_message
   *   记「回测层失败: ...」+ **不 rethrow**；质量层数据（trade/聚合列/completed）保留。
   */
  private async runBacktestLayer(
    backtestConfig: SignalTestBacktestConfig,
    runId: string,
  ): Promise<void> {
    try {
      // ⑤ 扁平单源 backtest_config → 引擎 PortfolioSimConfig{ sources:[{ runId: 本 runId }] }。
      const cfg = this.buildSingleSourceConfig(backtestConfig, runId);

      await this.runRepo.update(runId, {
        phase: 'replaying',
        progressTotal: 0,
        progressScanned: 0,
      });

      const { input } = await this.portfolioSimLoader.load(cfg);

      // ⑥ 引擎回放（纯函数，不落 portfolio_sim_* 表）。onProgress 驱动 replaying 进度。
      //    用与质量层同款节流器：bump 仅记内存，setInterval 周期 flush，stop 最终矫正。
      await this.runRepo.update(runId, { progressTotal: input.calendar.length });
      const replay = this.makePhaseProgress(runId);
      replay.start();
      let result;
      try {
        result = runPortfolioSim(input, () => replay.bump(1));
      } finally {
        await replay.stop();
      }

      // ⑦ phase='writing'：先 DELETE（幂等重跑）→ 批量 insert dailyRows → UPDATE 回测列。
      await this.runRepo.update(runId, {
        phase: 'writing',
        progressTotal: result.dailyRows.length,
        progressScanned: 0,
      });
      await this.equityRepo.delete({ runId });
      await this.insertEquityBatched(runId, result.dailyRows);
      await this.runRepo.update(runId, this.summaryToColumns(result.summary));

      this.logger.log(
        `SignalStatsRun ${runId} 回测层完成: equityDays=${result.dailyRows.length}, ` +
        `finalNav=${result.summary.finalNav}, totalRet=${result.summary.totalRet}, ` +
        `nTaken=${result.summary.nTaken}/nSkipped=${result.summary.nSkipped}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `SignalStatsRun ${runId} 回测层失败: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      // 回测 11 列置 null + error_message 提示；**不 rethrow**（质量层数据保留，run 仍 completed）。
      await this.runRepo.update(runId, {
        ...this.nullBacktestColumns(),
        errorMessage: `回测层失败: ${msg}`,
      });
    }
  }

  /**
   * 扁平单源 backtest_config → 引擎 PortfolioSimConfig（spec 02 §2.2 / 04 §4.4）。
   * 单元素 sources[0]，runId=本 run.id（loader 用它读 signal_test_trade）；账户级字段直透。
   * legacy rankField/rankDir 置 'none'/'asc'（rankSpec 接管排序；factors=[] 时按 ts_code 升序）。
   */
  private buildSingleSourceConfig(
    bc: SignalTestBacktestConfig,
    runId: string,
  ): PortfolioSimConfig {
    return {
      sources: [
        {
          runId,
          label: 'self',
          positionRatio: bc.positionRatio,
          maxPositions: bc.maxPositions,
          exposureCap: bc.exposureCap,
          rankField: 'none',
          rankDir: 'asc',
          rankSpec: bc.rankSpec,
          sizing: bc.sizing,
        },
      ],
      initialCapital: bc.initialCapital,
      cost: bc.cost,
      anchorMode: bc.anchorMode,
      circuitBreaker: bc.circuitBreaker ?? undefined,
    };
  }

  /** EngineSummary 11 字段 → signal_test_run 回测列（numeric → string，int → number）。 */
  private summaryToColumns(s: EngineSummary): Partial<SignalTestRunEntity> {
    const numStr = (v: number | null): string | null => (v === null ? null : String(v));
    return {
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
    };
  }

  /** 回测 11 列全置 null（回测层失败时回滚回测视图，质量列不动）。 */
  private nullBacktestColumns(): Partial<SignalTestRunEntity> {
    return {
      finalNav: null,
      totalRet: null,
      annualRet: null,
      maxDrawdown: null,
      sharpe: null,
      calmar: null,
      dailyWinRate: null,
      dailyKelly: null,
      nTaken: null,
      nSkipped: null,
      totalCosts: null,
    };
  }

  /** 分批插入 signal_test_equity（每批 200 行，numeric 列以 string 存）。 */
  private async insertEquityBatched(
    runId: string,
    rows: EngineDailyRow[],
  ): Promise<void> {
    const BATCH = 200;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const entities = slice.map((r) =>
        this.equityRepo.create({
          runId,
          tradeDate: r.tradeDate,
          nav: String(r.nav),
          cash: String(r.cash),
          dailyRet: String(r.dailyRet),
          exposure: String(r.exposure),
          positionCount: r.positionCount,
        }),
      );
      await this.equityRepo.save(entities);
      written += slice.length;
      await this.runRepo.update(runId, { progressScanned: written });
    }
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
