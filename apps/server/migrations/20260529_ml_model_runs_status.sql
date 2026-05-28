-- =====================================================================
-- 20260529_ml_model_runs_status.sql
--
-- spec 2026-05-29 P2.1：给 ml.model_runs 增加 status 列，标记 prod / shadow。
-- infer CLI 自动选模型时 P0 阶段按 max(created_at)；本 migration 落地后
-- 切到 WHERE status='prod' 口径。
--
-- 同时把现有 lgb-lambdarank-v1-20260521-seed42（如存在）升为 prod，作为
-- seed-averaging 集成模型上线前的过渡 prod。
--
-- CLAUDE.md 硬约束：DB schema 调整须附 docker exec 形式的 .ps1 + .sql 配对
-- Alembic 等价 migration：20260529_0001_add_model_runs_status.py
-- =====================================================================

ALTER TABLE ml.model_runs
  ADD COLUMN status TEXT NOT NULL DEFAULT 'shadow';

-- 加 CHECK 约束，避免任意字符串污染（与运维流程对齐：仅 prod / shadow / archived）
ALTER TABLE ml.model_runs
  ADD CONSTRAINT chk_model_runs_status
    CHECK (status IN ('prod', 'shadow', 'archived'));

-- 选 prod 的常用查询索引：WHERE status='prod' ORDER BY created_at DESC
CREATE INDEX idx_model_runs_status_created
  ON ml.model_runs (status, created_at DESC);

-- 过渡 prod：如存在 P0 阶段的单 seed 模型，升级为 prod；不存在则无副作用
UPDATE ml.model_runs
   SET status = 'prod'
 WHERE model_version = 'lgb-lambdarank-v1-20260521-seed42';
