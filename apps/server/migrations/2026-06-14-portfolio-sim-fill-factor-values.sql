-- =====================================================================
-- 2026-06-14-portfolio-sim-fill-factor-values.sql
-- Add factor_values (jsonb) and rank_score (numeric) columns to
-- portfolio_sim_fill for per-factor transparency (spec 08-persistence).
--   factor_values: {factorKey: value|null, ...} 逐因子原始值（taken/skipped 都写，
--                  含熔断冻结 skip 的笔）。
--   rank_score:    composite 综合分（单因子=该因子值；none=null）。rank_value（现列）
--                  继续写同值，保现有展示/排序兜底不破。
-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable, no DEFAULT, no backfill —
-- legacy rows stay NULL → 详情降级显示「—」。No CHECK / index change
-- (factor_values 仅展示，不进 WHERE/ORDER，无需索引)。
-- =====================================================================
ALTER TABLE portfolio_sim_fill
  ADD COLUMN IF NOT EXISTS factor_values jsonb NULL,
  ADD COLUMN IF NOT EXISTS rank_score    numeric NULL;
