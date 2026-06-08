-- =====================================================================
-- 20260608_signal_test_run_best_trade_ret.sql
--
-- Add best_trade_ret column to signal_test_run and backfill from
-- signal_test_trade.
--
-- Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
--             UPDATE only rows where best_trade_ret IS NULL.
-- =====================================================================

-- 加列（幂等）
ALTER TABLE signal_test_run ADD COLUMN IF NOT EXISTS best_trade_ret numeric;

-- 回填存量：从该 run 的逐笔明细取 max(ret)。test 一次性、不重跑，旧 run 必须回填。
UPDATE signal_test_run r
   SET best_trade_ret = sub.max_ret
  FROM (
    SELECT run_id, max(ret) AS max_ret
      FROM signal_test_trade
     GROUP BY run_id
  ) sub
 WHERE r.id = sub.run_id
   AND r.best_trade_ret IS NULL;
