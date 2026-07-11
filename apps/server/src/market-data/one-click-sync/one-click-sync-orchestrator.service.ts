// 「一键同步」后端托管编排器。
//
// spec docs/superpowers/specs/2026-06-16-one-click-sync-backend-orchestration-design.md §2/§4/§5/§6。
//
// 职责：
//  - 单飞（status='running' 命中则复用，不新建）
//  - detached async 跑 13 步（订阅 Subject / await POST），改内存态、节流刷 DB
//  - 步骤间检查 cancel_requested（标剩余 skipped 后 break）
//  - 终态写 status/finished_at/current_step=null
//  - OnModuleInit boot-sweep：把残留 running 标 failed（服务重启中断）
//
// 13 步逻辑细节在 step-runners.ts（忠实搬运前端 useOneClickSync.ts）。

import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OneClickSyncRunEntity } from '../../entities/market-data/one-click-sync-run.entity';
import { BaseDataSyncService } from '../base-data-sync/base-data-sync.service';
import { ASharesService } from '../a-shares/a-shares.service';
import { MoneyFlowSyncService } from '../money-flow/money-flow-sync.service';
import { ThsIndexDailySyncService } from '../ths-index-daily/ths-index-daily-sync.service';
import { SwIndexDailySyncService } from '../sw-index-daily/sw-index-daily-sync.service';
import { MarketIndexSyncService } from '../ths-index-daily/market-index-sync.service';
import { ActiveMvService } from '../active-mv/active-mv.service';
import { OamvService } from '../oamv/oamv.service';
import { EtfService } from '../etf/etf.service';
import { EtfAmvService } from '../etf/etf-amv.service';
import { EtfMfService } from '../etf/etf-mf.service';
import {
  buildInitialSteps,
  DB_FLUSH_THROTTLE_MS,
  LOG_LIMIT,
  STEP_ORDER,
  type LogEntry,
  type OneClickStepKey,
  type OneClickStepState,
  type OneClickStepStatus,
  type OneClickSyncRunDto,
} from './types';
import {
  runAShares,
  runBaseData,
  runConceptAmv,
  runSwAmv,
  runIndustryAmv,
  runMoneyFlow,
  runOamv,
  runThsIndexDaily,
  type StepContext,
} from './step-runners';
import { runMarketIndexDaily, runSwIndexDaily } from './step-runners-index-daily';
import { runEtf, runEtfAmv, runEtfMf } from './step-runners-etf';

type StepRunner = (ctx: StepContext, index: number) => Promise<void>;

const STEP_RUNNERS: StepRunner[] = [
  runBaseData,
  runAShares,
  runMoneyFlow,
  runThsIndexDaily,
  runSwIndexDaily,
  runMarketIndexDaily,
  runEtf,
  runEtfAmv,
  runEtfMf,
  runIndustryAmv,
  runConceptAmv,
  runSwAmv,
  runOamv,
];

@Injectable()
export class OneClickSyncOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OneClickSyncOrchestratorService.name);

  /**
   * 进程内 AbortController 索引（runId → controller）。
   *
   * 双重取消真相源：
   *  - AbortController（进程内）→ cancelRun 触发 abort()，各 step/底层 service 在循环顶部秒级响应，
   *    打破「当前步必须跑完」的旧限制（spec §6 line 269-270 曾明确接受该限制，本改动突破之）。
   *  - cancel_requested 列（DB 持久化）→ 重启后仍可识别；编排器步骤间循环顶部 isCancelRequested 兜底。
   *
   * 生命周期：startRun 时不创建（orchestrate detached 才创建），cancelRun 时按 id 取出并 abort；
   * orchestrate 结束（finalize）后清理。若 cancel 早于 orchestrate 启动（极小窗口），fallback 到 DB 标记。
   */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    @InjectRepository(OneClickSyncRunEntity)
    private readonly runRepo: Repository<OneClickSyncRunEntity>,
    private readonly baseData: BaseDataSyncService,
    private readonly aShares: ASharesService,
    private readonly moneyFlow: MoneyFlowSyncService,
    private readonly thsIndexDaily: ThsIndexDailySyncService,
    private readonly swIndexDaily: SwIndexDailySyncService,
    private readonly marketIndexSync: MarketIndexSyncService,
    private readonly activeMv: ActiveMvService,
    private readonly oamv: OamvService,
    private readonly etf: EtfService,
    private readonly etfAmv: EtfAmvService,
    private readonly etfMf: EtfMfService,
  ) {}

  /**
   * Boot-sweep：进程重启后把残留 running 标 failed（单实例前提，不引入 heartbeat/reaper）。
   */
  async onModuleInit(): Promise<void> {
    const res = await this.runRepo
      .createQueryBuilder()
      .update(OneClickSyncRunEntity)
      .set({
        status: 'failed',
        errorText: '服务重启中断',
        finishedAt: () => 'now()',
        currentStep: null,
        updatedAt: () => 'now()',
      })
      .where('status = :status', { status: 'running' })
      .execute();
    if (res.affected && res.affected > 0) {
      this.logger.warn(`boot-sweep：${res.affected} 个残留 running run 标为 failed（服务重启中断）`);
    }
  }

  /**
   * POST /runs：单飞 + 插行 + detached 编排。
   * 命中 running 直接复用（不新建）；否则插行并甩 detached async，立即返回新行。
   *
   * options.syncMode / options.selectedSteps 仅作参数透传给 orchestrate / ctx，
   * **不持久化**到 run entity（避免 migration 加列）。
   * 单飞语义：命中已有 running 时直接返回，忽略新参数（不能中途改模式/选择）。
   */
  async startRun(
    startDate: string,
    endDate: string,
    options: { syncMode?: 'incremental' | 'overwrite'; selectedSteps?: string[] },
    createdBy: string | null,
  ): Promise<OneClickSyncRunDto> {
    const active = await this.findRunning();
    if (active) {
      return this.toDto(active);
    }
    const entity = this.runRepo.create({
      status: 'running',
      startDate,
      endDate,
      progress: 0,
      currentStep: 0,
      steps: buildInitialSteps(),
      logs: [
        {
          ts: Date.now(),
          step: 'system',
          level: 'info',
          text: `开始一键同步：${startDate} ~ ${endDate}`,
        } as LogEntry,
      ],
      errorText: null,
      cancelRequested: false,
      createdBy,
    });
    const saved = await this.runRepo.save(entity);
    // detached：不 await，立即返回新行（类似现有 setTimeout 模式）。
    void this.orchestrate(saved.id, options).catch((err) => {
      this.logger.error(
        `编排器异常 run=${saved.id}: ${err instanceof Error ? err.stack : String(err)}`,
      );
    });
    return this.toDto(saved);
  }

  /** 最近一次 status='success' 的 run（标题「最近成功」标签用；无则 null）。走索引 ix_ocsr_status_started。 */
  async getLatestSuccess(): Promise<OneClickSyncRunDto | null> {
    const [run] = await this.runRepo.find({
      where: { status: 'success' },
      order: { startedAt: 'DESC' },
      take: 1,
    });
    return run ? this.toDto(run) : null;
  }

  /** GET /runs/active：有活跃返回活跃；否则返回最近一条（供 onMounted 恢复）。 */
  async getActiveOrLatest(): Promise<OneClickSyncRunDto | null> {
    const running = await this.findRunning();
    if (running) return this.toDto(running);
    const [latest] = await this.runRepo.find({
      order: { startedAt: 'DESC' },
      take: 1,
    });
    return latest ? this.toDto(latest) : null;
  }

  /** GET /runs/:id。 */
  async getRun(id: string): Promise<OneClickSyncRunDto> {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw new NotFoundException('一键同步任务不存在');
    return this.toDto(run);
  }

  /**
   * POST /runs/:id/cancel：置 cancel_requested=true + 触发进程内 AbortController.abort()。
   *
   * AbortController 让各 step / 底层 service 在循环顶部秒级中断（打破旧限制）；
   * cancel_requested 列同时写入 DB，作为重启后仍可识别的持久化真相。
   * 若 AbortController 尚未注册（orchestrate 还没启动，极小窗口），仅 DB 标记，
   * orchestrate 启动后会在第一次步骤间检查或首步 signal 检查时感知。
   */
  async cancelRun(id: string): Promise<OneClickSyncRunDto> {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw new NotFoundException('一键同步任务不存在');
    if (run.status === 'running' && !run.cancelRequested) {
      await this.runRepo.update({ id }, { cancelRequested: true, updatedAt: () => 'now()' });
      run.cancelRequested = true;
      // 触发进程内中断（若 controller 已注册）。已注册但被 finalize 清理的情况无妨——DB 标记已兜底。
      const controller = this.abortControllers.get(id);
      if (controller) controller.abort();
    }
    return this.toDto(run);
  }

  // ── 编排主体（detached）──────────────────────────────────────────────
  private async orchestrate(
    runId: string,
    options: { syncMode?: 'incremental' | 'overwrite'; selectedSteps?: string[] } = {},
  ): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      this.logger.error(`orchestrate：run ${runId} 不存在`);
      return;
    }

    // 创建并注册 AbortController —— cancelRun 可通过 abort() 秒级中断当前正在执行的步骤。
    // 用 try/finally 保证无论编排如何结束都清理 Map（避免内存泄漏）。
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    // 若 cancel 早于 orchestrate 启动（极小窗口，DB cancelRequested 已 true 但 controller 尚未注册），
    // 立即 abort 新建的 controller，使首步循环顶部即可感知取消。
    if (run.cancelRequested) abortController.abort();
    // 内存工作态：steps/logs 直接改，节流刷库。
    const state = {
      steps: run.steps.length === STEP_ORDER.length ? run.steps : buildInitialSteps(),
      logs: run.logs ?? [],
    };
    let lastFlush = 0;

    // selectedSteps 空/缺省 = 全选（兼容旧请求 + 默认全勾）；非空时转 Set 加速 includes。
    const selectedSet = options.selectedSteps && options.selectedSteps.length > 0
      ? new Set(options.selectedSteps)
      : null;

    const flushNow = async (extra?: Partial<OneClickSyncRunEntity>) => {
      lastFlush = Date.now();
      await this.runRepo.update(
        { id: runId },
        {
          steps: state.steps,
          logs: state.logs,
          progress: computeProgress(state.steps),
          updatedAt: () => 'now()',
          ...extra,
        },
      );
    };

    const ctx: StepContext = {
      range: { startDate: run.startDate, endDate: run.endDate },
      syncMode: options.syncMode === 'overwrite' ? 'overwrite' : 'incremental',
      signal: abortController.signal,
      services: {
        baseData: this.baseData,
        aShares: this.aShares,
        moneyFlow: this.moneyFlow,
        thsIndexDaily: this.thsIndexDaily,
        swIndexDaily: this.swIndexDaily,
        marketIndexSync: this.marketIndexSync,
        activeMv: this.activeMv,
        oamv: this.oamv,
        etf: this.etf,
        etfAmv: this.etfAmv,
        etfMf: this.etfMf,
      },
      patchStep: (index, patch) => {
        Object.assign(state.steps[index], patch);
      },
      setStatus: (index, status) => setStepStatus(state.steps[index], status),
      pushLog: (step, level, text) => pushLog(state.logs, { ts: Date.now(), step, level, text }),
      getStep: (index) => state.steps[index],
      flushThrottled: () => {
        if (Date.now() - lastFlush >= DB_FLUSH_THROTTLE_MS) {
          void flushNow().catch((err) =>
            this.logger.warn(`节流刷库失败 run=${runId}: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      },
    };

    let cancelled = false;
    let curIndex = -1; // AbortError 冒泡时定位"当前步"，用于裁决该步及剩余为 skipped。
    try {
      for (let i = 0; i < STEP_RUNNERS.length; i++) {
        curIndex = i;
        // 步骤间检查 cancel（DB 是真相源；AbortController 中断后当前步会抛 AbortError，这里仍兜底）。
        if (await this.isCancelRequested(runId)) {
          cancelled = true;
          markRemainingSkipped(state.steps, i);
          pushLog(state.logs, {
            ts: Date.now(),
            step: 'system',
            level: 'warn',
            text: '一键同步已取消',
          });
          break;
        }
        // 按需勾选：selectedSet 非空且当前 step key 未勾选 → 标 skipped，不调 runner。
        // 空/缺省 = 全选（selectedSet 为 null），兼容旧请求 + 默认全勾。
        const stepKey = STEP_ORDER[i];
        if (selectedSet && !selectedSet.has(stepKey)) {
          setStepStatus(state.steps[i], 'skipped');
          pushLog(state.logs, {
            ts: Date.now(),
            step: stepKey,
            level: 'info',
            text: '已跳过（未勾选）',
          });
          await flushNow({ currentStep: i });
          continue;
        }
        // 步骤切换必刷库 + current_step。
        await flushNow({ currentStep: i });
        // AbortError 由 step-runner 的 catch 透传上来（见 step-runners rethrowIfAbort），
        // 表示当前步在"完成某个工作单元落库后"被取消中断 → catch 里裁决为 cancelled。
        await STEP_RUNNERS[i](ctx, i);
        // 步骤完成必刷库。
        await flushNow({ currentStep: i });
      }
    } catch (err) {
      if (isAbortError(err)) {
        // 取消中断：当前步（curIndex）在抛 AbortError 前已完成当前工作单元落库；
        // 把当前步（可能被 failStep 标过 failed → 取消优先回改 skipped）及剩余标 skipped，终态 cancelled。
        cancelled = true;
        markAbortedFromSkipped(state.steps, Math.max(0, curIndex));
        pushLog(state.logs, {
          ts: Date.now(),
          step: 'system',
          level: 'warn',
          text: '一键同步已取消',
        });
      } else {
        // 编排级异常（理论上各 runner 已自吞，这里兜底）。
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`orchestrate 主体异常 run=${runId}: ${msg}`);
        pushLog(state.logs, { ts: Date.now(), step: 'system', level: 'error', text: `编排异常：${msg}` });
        await this.finalize(runId, state, 'failed', msg);
        return;
      }
    } finally {
      // 清理 AbortController（无论正常结束 / 取消 / 失败）。cancelRun 之后的 abort 调用为 no-op。
      this.abortControllers.delete(runId);
    }

    const finalStatus = cancelled ? 'cancelled' : computeFinalStatus(state.steps);
    if (!cancelled) {
      const failedCount = state.steps.filter((s) => s.status === 'failed').length;
      pushLog(state.logs, {
        ts: Date.now(),
        step: 'system',
        level: failedCount > 0 ? 'warn' : 'info',
        text:
          failedCount > 0
            ? `一键同步结束：${failedCount}/${state.steps.length} 步骤失败`
            : '一键同步全部完成',
      });
    }
    await this.finalize(runId, state, finalStatus, null);
  }

  private async finalize(
    runId: string,
    state: { steps: OneClickStepState[]; logs: LogEntry[] },
    status: OneClickSyncRunDto['status'],
    errorText: string | null,
  ): Promise<void> {
    await this.runRepo.update(
      { id: runId },
      {
        status,
        steps: state.steps,
        logs: state.logs,
        progress: computeProgress(state.steps),
        currentStep: null,
        errorText,
        finishedAt: () => 'now()',
        updatedAt: () => 'now()',
      },
    );
  }

  private async isCancelRequested(runId: string): Promise<boolean> {
    const row = await this.runRepo.findOne({ where: { id: runId }, select: ['cancelRequested'] });
    return row?.cancelRequested ?? false;
  }

  private async findRunning(): Promise<OneClickSyncRunEntity | null> {
    return this.runRepo.findOne({
      where: { status: 'running' },
      order: { startedAt: 'DESC' },
    });
  }

  // ── 实体 → camelCase 出参（时间列转 UTC 墙钟串）──────────────────────
  private toDto(e: OneClickSyncRunEntity): OneClickSyncRunDto {
    return {
      id: e.id,
      status: e.status,
      startDate: e.startDate,
      endDate: e.endDate,
      progress: e.progress,
      currentStep: e.currentStep,
      steps: e.steps,
      logs: e.logs,
      errorText: e.errorText,
      cancelRequested: e.cancelRequested,
      createdBy: e.createdBy,
      startedAt: formatUtcWallClock(e.startedAt),
      updatedAt: formatUtcWallClock(e.updatedAt),
      finishedAt: e.finishedAt ? formatUtcWallClock(e.finishedAt) : null,
    };
  }
}

// ── 模块级纯函数 ──────────────────────────────────────────────────────

/** 是否 AbortError（底层 service 在循环顶部检查 signal.aborted 后抛出，名 'AbortError'）。 */
export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

function setStepStatus(step: OneClickStepState, status: OneClickStepStatus): void {
  step.status = status;
  if (status === 'running' && step.startedAt === null) step.startedAt = Date.now();
  if (
    (status === 'success' || status === 'failed' || status === 'skipped') &&
    step.finishedAt === null
  ) {
    step.finishedAt = Date.now();
  }
}

function markRemainingSkipped(steps: OneClickStepState[], fromIndex: number): void {
  for (let i = fromIndex; i < steps.length; i++) {
    if (steps[i].status === 'pending') setStepStatus(steps[i], 'skipped');
  }
}

/**
 * AbortError 中断专用：把被中断的当前步（可能是 running/failed）及其后 pending 步统一标 skipped。
 * 与 markRemainingSkipped 区别：后者只改 pending（步骤间取消，已完成步保持原态）；
 * 本函数额外把"被中断的当前步"回改为 skipped —— 取消优先，不把因取消导致的半途中断显成失败。
 */
function markAbortedFromSkipped(steps: OneClickStepState[], curIndex: number): void {
  for (let i = curIndex; i < steps.length; i++) {
    if (steps[i].status === 'pending' || steps[i].status === 'running' || steps[i].status === 'failed') {
      setStepStatus(steps[i], 'skipped');
    }
  }
}

function pushLog(logs: LogEntry[], entry: LogEntry): void {
  logs.push(entry);
  if (logs.length > LOG_LIMIT) {
    logs.splice(0, logs.length - LOG_LIMIT);
  }
}

/** 总进度镜像前端 totalPercent：每步终态算 100，running 算其 percent，÷8 取整。 */
function computeProgress(steps: OneClickStepState[]): number {
  let acc = 0;
  for (const s of steps) {
    if (s.status === 'success' || s.status === 'failed' || s.status === 'skipped') {
      acc += 100;
    } else if (s.status === 'running') {
      acc += Math.max(0, Math.min(100, s.percent));
    }
  }
  return Math.round(acc / steps.length);
}

/** 10 步跑完后的终态：任一步 failed → failed，否则 success（取消由调用方判定）。 */
function computeFinalStatus(steps: OneClickStepState[]): 'success' | 'failed' {
  return steps.some((s) => s.status === 'failed') ? 'failed' : 'success';
}

/**
 * Date → UTC 墙钟字符串 'YYYY-MM-DD HH:mm:ssZ'。
 * 与项目既有 formatUtcWallClock 一致（quant-jobs / quant-runs）：尾 Z 保证前端
 * formatUTCDateTime 的 `new Date(input)` 按 UTC 解析（无 Z 会被当本地时间）。
 */
function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
