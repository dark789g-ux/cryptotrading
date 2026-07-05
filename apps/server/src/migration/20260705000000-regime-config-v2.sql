-- =====================================================================
-- 20260705000000-regime-config-v2.sql
--
-- Regime 配置 v2：象限 key 由用户自定义，不再限定 Q1-Q4。
-- 因此 regime_daily_pick.regime 列从 varchar(8) 扩到 varchar(32)，
-- 并清空历史 picks（新结构与旧 Q1-Q4 数据不兼容）。
-- =====================================================================

BEGIN;

ALTER TABLE regime_daily_pick ALTER COLUMN regime TYPE varchar(32);

TRUNCATE TABLE regime_daily_pick;

COMMIT;
