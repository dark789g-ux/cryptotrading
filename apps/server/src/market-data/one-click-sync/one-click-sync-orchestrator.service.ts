// 「一键同步」后端托管编排器。
//
// spec docs/superpowers/specs/2026-06-16-one-click-sync-backend-orchestration-design.md §2/§4/§5/§6。
//
// 职责：
//  - 单飞（status='running' 命中则复用，不新建）
//  - detached async 跑 10 步（订阅 Subject / await POST），改内存态、节流刷 DB
//  - 步骤间检查 cancel_requested（标剩余 skipped 后 break）
//  - 终态写 status/finished_at/current_step=null
//  - OnModuleInit boot-sweep：把残留 running 标 failed（服务重启中断）
//
// 8 步逻辑细节在 step-runners.ts（忠实搬运前端 useOneClickSync.ts）。

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
  runIndustryAmv,
  runMoneyFlow,
  runOamv,
  runStockAmv,
  runThsIndexDaily,
  type StepContext,
} from './step-runners';
import { runMarketIndexDaily, runSwIndexDaily } from './step-runners-index-daily';

type StepRunner = (ctx: StepContext, index: number) => Promise<void>;

const STEP_RUNNERS: StepRunner[] = [
  runBaseData,
  runAShares,
  runMoneyFlow,
  runThsIndexDaily,
  runSwIndexDaily,
  runMarketIndexDaily,
  runStockAmv,
  runIndustryAmv,
  runConceptAmv,
  runOamv,
];

@Injectable()
export class OneClickSyncOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OneClickSyncOrchestratorService.name);

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
   */
  async startRun(startDate: string, endDate: string, createdBy: string | null): Promise<OneClickSyncRunDto> {
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
    void this.orchestrate(saved.id).catch((err) => {
      this.logger.error(
        `编排器异常 run=${saved.id}: ${err instanceof Error ? err.stack : String(err)}`,
      );
    });
    return this.toDto(saved);
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

  /** POST /runs/:id/cancel：置 cancel_requested=true（编排器在步骤间检查）。 */
  async cancelRun(id: string): Promise<OneClickSyncRunDto> {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw new NotFoundException('一键同步任务不存在');
    if (run.status === 'running' && !run.cancelRequested) {
      await this.runRepo.update({ id }, { cancelRequested: true, updatedAt: () => 'now()' });
      run.cancelRequested = true;
    }
    return this.toDto(run);
  }

  // ── 编排主体（detached）──────────────────────────────────────────────
  private async orchestrate(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      this.logger.error(`orchestrate：run ${runId} 不存在`);
      return;
    }
    // 内存工作态：steps/logs 直接改，节流刷库。
    const state = {
      steps: run.steps.length === STEP_ORDER.length ? run.steps : buildInitialSteps(),
      logs: run.logs ?? [],
    };
    let lastFlush = 0;

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
      services: {
        baseData: this.baseData,
        aShares: this.aShares,
        moneyFlow: this.moneyFlow,
        thsIndexDaily: this.thsIndexDaily,
        swIndexDaily: this.swIndexDaily,
        marketIndexSync: this.marketIndexSync,
        activeMv: this.activeMv,
        oamv: this.oamv,
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
    try {
      for (let i = 0; i < STEP_RUNNERS.length; i++) {
        // 步骤间检查 cancel（DB 是真相源；当前步无法中断，与今天一致）。
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
        // 步骤切换必刷库 + current_step。
        await flushNow({ currentStep: i });
        await STEP_RUNNERS[i](ctx, i);
        // 步骤完成必刷库。
        await flushNow({ currentStep: i });
      }
    } catch (err) {
      // 编排级异常（理论上各 runner 已自吞，这里兜底）。
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`orchestrate 主体异常 run=${runId}: ${msg}`);
      pushLog(state.logs, { ts: Date.now(), step: 'system', level: 'error', text: `编排异常：${msg}` });
      await this.finalize(runId, state, 'failed', msg);
      return;
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
