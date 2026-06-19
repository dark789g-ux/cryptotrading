-- =====================================================================
-- M0 · 量化模型训练 schema 迁移：反向（回滚）脚本
--
-- 目标：把 raw.<table> 恢复回 public.a_share_<table>。
--
-- 注意：
--   - 必须与代码版本回退一起执行（git checkout quant-migration-base
--     并重新部署 NestJS），详见 01-pg-schema.md §6 回滚序列
--   - raw / factors / ml schema 保留不删除：factors / ml 下的 Python
--     Alembic 已写入对象时盲删会丢数据；raw 即使空了也无害
--   - 该脚本本身只回滚本里程碑搬迁的 5 张表
-- =====================================================================

BEGIN;

ALTER TABLE raw.daily_quote RENAME TO a_share_daily_quotes;
ALTER TABLE raw.a_share_daily_quotes SET SCHEMA public;

ALTER TABLE raw.daily_basic RENAME TO a_share_daily_metrics;
ALTER TABLE raw.a_share_daily_metrics SET SCHEMA public;

ALTER TABLE raw.adj_factor RENAME TO a_share_adj_factors;
ALTER TABLE raw.a_share_adj_factors SET SCHEMA public;

ALTER TABLE raw.daily_indicator RENAME TO a_share_daily_indicators;
ALTER TABLE raw.a_share_daily_indicators SET SCHEMA public;

ALTER TABLE raw.indicator_calc_state RENAME TO a_share_indicator_calc_states;
ALTER TABLE raw.a_share_indicator_calc_states SET SCHEMA public;

COMMIT;

-- 验证（手动执行，不在事务内）：
-- SELECT to_regclass('raw.daily_quote');                 -- 应当返回 NULL
-- SELECT to_regclass('public.a_share_daily_quotes') IS NOT NULL;  -- 应当返回 true
