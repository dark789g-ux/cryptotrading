import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionsRunner } from './strategy-conditions.runner';

const MAX_CONCURRENT_PER_USER = 3;
/** 孤儿 running 超时阈值（进程崩溃后留下的未完成 run）：30 分钟 */
const ORPHAN_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

@Injectable()
export class RunQueue implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunQueue.name);

  /** userId → 当前在跑的 runId 集合 */
  private readonly running = new Map<string, Set<string>>();
  /** 正在 drain 的 userId，防重入 */
  private readonly draining = new Set<string>();

  constructor(
    @InjectRepository(StrategyConditionRunEntity)
    private readonly runRepo: Repository<StrategyConditionRunEntity>,
    @InjectRepository(StrategyConditionEntity)
    private readonly condRepo: Repository<StrategyConditionEntity>,
    private readonly runner: StrategyConditionsRunner,
  ) {}

  /**
   * 尝试获取执行许可。返回 true 表示立即执行（已加入 running），false 表示排队等待。
   */
  async acquire(
    entity: StrategyConditionEntity,
    runId: string,
    userId: string,
  ): Promise<boolean> {
    const currentCount = this.running.get(userId)?.size ?? 0;
    if (currentCount < MAX_CONCURRENT_PER_USER) {
      this.add(userId, runId);
      // acquire 成功 → 立即启动执行
      this.runner
        .executeRun(entity, runId, userId, async (finalStatus) => {
          await this.release(runId, userId, finalStatus);
        })
        .catch((err) =>
          this.logger.error(
            `executeRun fire-and-forget failed, runId=${runId}`,
            err instanceof Error ? err.stack : String(err),
          ),
        );
      return true;
    }
    // 超限 → 保持 queued（service 已写入 DB），由 drain 调度
    return false;
  }

  private add(userId: string, runId: string): void {
    let set = this.running.get(userId);
    if (!set) {
      set = new Set();
      this.running.set(userId, set);
    }
    set.add(runId);
  }

  /**
   * 释放一个 runId（内存 Map + 触发 drain）。
   * 注意：终态（status/completedAt）由 runner.executeRun 写入，此处不重复写 DB。
   */
  async release(
    runId: string,
    userId: string,
    _finalStatus: 'completed' | 'failed',
  ): Promise<void> {
    this.running.get(userId)?.delete(runId);
    await this.drain(userId);
  }

  /**
   * 调度该用户排队的任务：从 DB 取最早的 queued run，逐个启动直到达到并发上限。
   * 重入保护：同一 userId 同时只允许一个 drain 在执行。
   */
  private async drain(userId: string): Promise<void> {
    if (this.draining.has(userId)) return;
    this.draining.add(userId);

    try {
      while (true) {
        const currentCount = this.running.get(userId)?.size ?? 0;
        if (currentCount >= MAX_CONCURRENT_PER_USER) break;

        const run = await this.runRepo.findOne({
          where: { userId, status: 'queued' as const },
          order: { createdAt: 'ASC' },
        });
        if (!run) break;

        // 查找 condition 实体
        const entity = await this.condRepo.findOne({
          where: { id: run.conditionId },
        });
        if (!entity) {
          this.logger.error(
            `drain: condition ${run.conditionId} not found, skipping queued run ${run.id}`,
          );
          // 标记 failed 防止无限循环
          await this.runRepo.update(run.id, {
            status: 'failed',
            errorMessage: '关联的条件不存在',
            completedAt: new Date(),
          });
          continue;
        }

        this.add(userId, run.id);
        // fire-and-forget
        this.runner
          .executeRun(entity, run.id, userId, async (finalStatus) => {
            await this.release(run.id, userId, finalStatus);
          })
          .catch((err) =>
            this.logger.error(
              `drain executeRun failed, runId=${run.id}`,
              err instanceof Error ? err.stack : String(err),
            ),
          );
      }
    } finally {
      this.draining.delete(userId);
    }
  }

  /**
   * NestJS 生命周期钩子：进程启动后恢复未完成的任务。
   * 策略：所有孤儿 running 全部标 failed（保守，不重跑），queued 按并发上限启动。
   */
  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Recovering strategy condition runs after restart...');

    let failed = 0;
    let restarted = 0;
    let stillQueued = 0;

    // 1. 扫孤儿 running → 全部标 failed
    const orphanRuns = await this.runRepo.find({ where: { status: 'running' as const } });
    for (const run of orphanRuns) {
      const isTimeout = Date.now() - run.createdAt.getTime() > ORPHAN_RUNNING_TIMEOUT_MS;
      const errorMsg = isTimeout
        ? '进程重启检测到孤儿任务（超时）'
        : '进程重启检测到未完成任务';
      await this.runRepo.update(run.id, {
        status: 'failed',
        errorMessage: errorMsg,
        completedAt: new Date(),
      });
      failed++;
    }

    // 2. 扫残留 queued → 按 userId 分组，每组前 N 个启动
    const queuedRuns = await this.runRepo.find({
      where: { status: 'queued' as const },
      order: { createdAt: 'ASC' },
    });

    // 按 userId 分组
    const byUser = new Map<string, StrategyConditionRunEntity[]>();
    for (const run of queuedRuns) {
      let arr = byUser.get(run.userId);
      if (!arr) {
        arr = [];
        byUser.set(run.userId, arr);
      }
      arr.push(run);
    }

    for (const [userId, runs] of byUser) {
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (i < MAX_CONCURRENT_PER_USER) {
          // 前 N 个：启动执行
          const entity = await this.condRepo.findOne({
            where: { id: run.conditionId },
          });
          if (!entity) {
            this.logger.error(
              `recovery: condition ${run.conditionId} not found, failing run ${run.id}`,
            );
            await this.runRepo.update(run.id, {
              status: 'failed',
              errorMessage: '关联的条件不存在',
              completedAt: new Date(),
            });
            failed++;
            continue;
          }

          this.add(userId, run.id);
          this.runner
            .executeRun(entity, run.id, userId, async (finalStatus) => {
              await this.release(run.id, userId, finalStatus);
            })
            .catch((err) =>
              this.logger.error(
                `recovery executeRun failed, runId=${run.id}`,
                err instanceof Error ? err.stack : String(err),
              ),
            );
          restarted++;
        } else {
          stillQueued++;
        }
      }
    }

    this.logger.log(
      `Recovery done: ${failed} failed, ${restarted} restarted, ${stillQueued} queued`,
    );
  }
}
