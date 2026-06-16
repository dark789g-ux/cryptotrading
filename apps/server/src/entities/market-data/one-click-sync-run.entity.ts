import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type {
  LogEntry,
  OneClickRunStatus,
  OneClickStepState,
} from '../../market-data/one-click-sync/types';

/**
 * `one_click_sync_runs`：「一键同步」后端托管编排的持久化任务进度行。
 *
 * spec docs/superpowers/specs/2026-06-16-one-click-sync-backend-orchestration-design.md §3。
 *
 * - public schema，纯 NestJS 自用（不属 ml.jobs 体系，不走 alembic）。
 * - 表由 migration 20260616170000-create-one-click-sync-runs.{sql,ps1} 建（synchronize: false）。
 * - 每次同步插一行；status='running' 全局单飞由编排器应用层保证。
 * - 时间列 timestamptz（遵循 .claude/rules/datetime.md）；出参由 service 转 UTC 墙钟串。
 * - steps/logs jsonb 结构对齐前端 OneClickStepState / LogEntry。
 *
 * ★双注册：本实体须同时在本文件 @Entity + app.module.ts 根 entities 数组注册，
 *   漏后者编译绿但运行时 EntityMetadataNotFound 500。
 */
@Entity('one_click_sync_runs')
@Index('ix_ocsr_status_started', ['status', 'startedAt'])
export class OneClickSyncRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  status: OneClickRunStatus;

  @Column({ name: 'start_date', length: 8 })
  startDate: string;

  @Column({ name: 'end_date', length: 8 })
  endDate: string;

  @Column({ type: 'smallint', default: 0 })
  progress: number;

  @Column({ name: 'current_step', type: 'smallint', nullable: true })
  currentStep: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  steps: OneClickStepState[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  logs: LogEntry[];

  @Column({ name: 'error_text', type: 'text', nullable: true })
  errorText: string | null;

  @Column({ name: 'cancel_requested', type: 'boolean', default: false })
  cancelRequested: boolean;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
