-- =====================================================================
-- 20260524_ml_jobs_warnings.sql
--
-- PIT 窗口护门 Migration B（spec 2026-05-23-pit-window-guard-design §06.1）：
--   - 给 ml.jobs 增加 warnings JSONB 列（默认 '[]'）
--   - runner 通过 JSONB || 操作符 append 单元素数组，progress.update_progress
--     推送 SSE 时携带 warnings_summary 聚合计数
--
-- CLAUDE.md 硬约束：DB schema 调整须附 docker exec 形式的 .ps1 + .sql 配对
-- 与 Alembic migration 20260525_0002_add_ml_jobs_warnings.py 内容必须等价
-- =====================================================================

ALTER TABLE ml.jobs
  ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
