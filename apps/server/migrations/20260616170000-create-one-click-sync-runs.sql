-- =====================================================================
-- 20260616170000-create-one-click-sync-runs.sql
--
-- 「一键同步」后端托管编排：持久化任务进度表 one_click_sync_runs。
-- spec docs/superpowers/specs/2026-06-16-one-click-sync-backend-orchestration-design.md §3
--
-- 设计要点：
--  - public schema，纯 NestJS 自用，不属 ml.jobs 体系，故不碰 alembic。
--  - 每次同步插一行（多行历史，非单行覆盖）；status='running' 全局单飞由应用层保证。
--  - 时间列一律 timestamptz（遵循 .claude/rules/datetime.md）。
--  - steps/logs 为 jsonb，结构对齐前端 OneClickStepState / LogEntry。
-- =====================================================================

CREATE TABLE IF NOT EXISTS one_click_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL,
  start_date varchar(8) NOT NULL,
  end_date varchar(8) NOT NULL,
  progress smallint NOT NULL DEFAULT 0,
  current_step smallint,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_text text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT ck_ocsr_status CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
  CONSTRAINT ck_ocsr_progress CHECK (progress >= 0 AND progress <= 100)
);

-- 查活跃 / 最近一条（GET /runs/active 与单飞 SELECT 都按 (status, started_at DESC)）。
CREATE INDEX IF NOT EXISTS ix_ocsr_status_started
  ON one_click_sync_runs (status, started_at DESC);
