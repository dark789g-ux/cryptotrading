import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `ml.jobs`：量化训练 / 推理 / 因子 / 标签 等所有后台作业的统一队列。
 *
 * - schema/name 来自 doc/specs/2026-05-17-quant-model-training/01-pg-schema.md §4
 * - 表本身由 Python 侧 Alembic 在 M0 已建好（synchronize: false）
 * - NestJS 是 jobs 的写者（POST /quant/jobs 触发插入），Python worker 是消费者
 */
export type MlJobStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type MlJobRunType =
  | 'noop'
  | 'sync'
  | 'quality'
  | 'factors'
  | 'labels'
  | 'features'
  | 'train'
  | 'infer'
  | 'optuna'
  | 'seed_avg'
  | 'train_e2e';

@Entity({ schema: 'ml', name: 'jobs' })
@Index(['status', 'priority', 'createdAt'])
export class MlJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'run_type', type: 'text' })
  runType: MlJobRunType;

  /** 各 run_type 的参数 schema 见 01-pg-schema.md §4.1，统一 jsonb 存储 */
  @Column({ name: 'params', type: 'jsonb', default: () => "'{}'::jsonb" })
  params: Record<string, unknown>;

  @Index()
  @Column({ name: 'status', type: 'text', default: 'pending' })
  status: MlJobStatus;

  @Column({ name: 'progress', type: 'smallint', default: 0 })
  progress: number;

  @Column({ name: 'stage', type: 'text', nullable: true })
  stage: string | null;

  @Column({ name: 'priority', type: 'smallint', default: 100 })
  priority: number;

  @Column({ name: 'attempts', type: 'smallint', default: 0 })
  attempts: number;

  @Column({ name: 'max_attempts', type: 'smallint', default: 1 })
  maxAttempts: number;

  /** worker 每 30s 回写 heartbeat，reaper 用本字段判断 running job 是否失联 */
  @Column({ name: 'heartbeat_at', type: 'timestamptz', nullable: true })
  heartbeatAt: Date | null;

  /** NestJS 写 true，Python worker 读到后自行中止并把 status 改为 cancelled */
  @Column({ name: 'cancel_requested', type: 'boolean', default: false })
  cancelRequested: boolean;

  @Column({ name: 'parent_job_id', type: 'uuid', nullable: true })
  parentJobId: string | null;

  @Column({ name: 'log_url', type: 'text', nullable: true })
  logUrl: string | null;

  @Column({ name: 'error_text', type: 'text', nullable: true })
  errorText: string | null;

  @Column({ name: 'blocked_reason', type: 'text', nullable: true })
  blockedReason: string | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  /**
   * train_e2e 等流水线 run_type 完成后回写的结果摘要(D-13)。
   *
   * 典型字段:
   * - `feature_set_id`：worker labels→features 阶段派生出的 feature_set 主键
   * - `step_snapshots`：各 step 进度/耗时快照
   *
   * 老 run_type(train/optuna/seed_avg/...)默认为空对象,前端 RunDetail 缺字段不展示(D-21)。
   * jsonb 列在 NestJS 侧不强类型映射 —— 仅做透传,字段 schema 见 spec 04 文档。
   */
  @Column({ name: 'result_payload', type: 'jsonb', default: () => "'{}'::jsonb" })
  resultPayload: Record<string, unknown>;
}
