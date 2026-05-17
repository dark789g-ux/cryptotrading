-- =====================================================================
-- M0 · 量化模型训练 schema 迁移：正向脚本
--
-- 目标：
--   1. 创建 raw / factors / ml 三个 schema（IF NOT EXISTS）
--   2. 把 5 张既有 A 股表从 public 搬到 raw，并去掉 a_share_ 前缀
--      （a_share_daily_quotes      → raw.daily_quote）
--      （a_share_daily_metrics     → raw.daily_basic）   注意：metrics → basic
--      （a_share_adj_factors       → raw.adj_factor）
--      （a_share_daily_indicators  → raw.daily_indicator）
--      （a_share_indicator_calc_states → raw.indicator_calc_state）
--
-- 说明：
--   - factors / ml schema 仅创建空 schema，其下表 DDL 由 Python 侧
--     Alembic 管理，本脚本不创建任何表。
--   - a_share_symbols / a_share_sync_states / a_share_filter_presets
--     不在本里程碑迁移范围，仍保留在 public。
--   - ALTER SCHEMA / RENAME TABLE 是 PG 元数据级操作，不复制数据。
--   - 配套回滚脚本：20260517120000-quant-raw-schema-migration.down.sql
--   - 执行序列与 git tag 协议详见 doc/specs/2026-05-17-quant-model-training/01-pg-schema.md §6
-- =====================================================================

BEGIN;

-- 1) 创建三个目标 schema（幂等）
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS factors;
CREATE SCHEMA IF NOT EXISTS ml;

-- 2) 5 张表：先 SET SCHEMA 到 raw，再 RENAME 去前缀
ALTER TABLE public.a_share_daily_quotes SET SCHEMA raw;
ALTER TABLE raw.a_share_daily_quotes RENAME TO daily_quote;

-- 旧表名 a_share_daily_metrics，目标 raw.daily_basic（命名按 01-pg-schema §2 旧→新映射）
ALTER TABLE public.a_share_daily_metrics SET SCHEMA raw;
ALTER TABLE raw.a_share_daily_metrics RENAME TO daily_basic;

ALTER TABLE public.a_share_adj_factors SET SCHEMA raw;
ALTER TABLE raw.a_share_adj_factors RENAME TO adj_factor;

ALTER TABLE public.a_share_daily_indicators SET SCHEMA raw;
ALTER TABLE raw.a_share_daily_indicators RENAME TO daily_indicator;

ALTER TABLE public.a_share_indicator_calc_states SET SCHEMA raw;
ALTER TABLE raw.a_share_indicator_calc_states RENAME TO indicator_calc_state;

COMMIT;

-- 验证（手动执行，不在事务内）：
-- \dn                                      -- 应当包含 raw / factors / ml
-- \dt raw.*                                -- 应当列出 5 张已迁移表
-- SELECT to_regclass('public.a_share_daily_quotes');     -- 应当返回 NULL
-- SELECT to_regclass('raw.daily_quote') IS NOT NULL;     -- 应当返回 true
