-- 清理美股 pre-2024 旧行（数据源 AkShare→Yahoo 迁移，"先灌后删"收尾）
--
-- 背景：美股数据源从 AkShare(新浪 stock_us_daily) 切到 Yahoo chart API，采用
-- "先灌后删"：先用 Yahoo 源重灌 2024-01-01 起的数据（us-sync / us-index-sync 窗口
-- 20240101+，us-index-amv-sync 分析起点 2025-01-01，2024 段作 MA240/AMV 热身缓冲），
-- 校验通过后再执行本脚本，删除 6 张表中 trade_date < '20240101' 的全部行。
-- 同时清掉换源前残留的孤儿行（如 AMV 成分 FANG/KLAC/LRCX/STX 的旧 qfq 全空行）。
--
-- ⚠️ 执行前提（spec §E）：必须已 Yahoo 重灌 2024-01-01 起并校验通过，再跑本脚本。
-- 幂等：纯 DELETE ... WHERE，可重复执行无副作用。
-- 6 表日期列均为 trade_date character varying(8)（已落 information_schema 核对）。

BEGIN;

DELETE FROM raw.us_daily_quote     WHERE trade_date < '20240101';
DELETE FROM raw.us_adj_factor      WHERE trade_date < '20240101';
DELETE FROM raw.us_daily_indicator WHERE trade_date < '20240101';
DELETE FROM raw.us_index_daily     WHERE trade_date < '20240101';
DELETE FROM raw.us_index_indicator WHERE trade_date < '20240101';
DELETE FROM raw.us_index_amv_daily WHERE trade_date < '20250102';  -- AMV 分析起点 2025-01-02（2024 仅热身、不出 AMV 值）

-- 剔除 Yahoo 偶发占位行（close 为 null，非有效交易观测）。dropna 修复后不再产生，
-- 此处清掉换源初期遗留的少量占位行（如 GEV 首轮重灌写入的 1 行）。指数同理。
DELETE FROM raw.us_daily_quote WHERE close IS NULL;
DELETE FROM raw.us_index_daily WHERE close IS NULL;

COMMIT;
