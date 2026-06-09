-- 20260609_signal_test_trade_run_ret_index.sql
--
-- 为 signal_test_trade 表新增 (run_id, ret) 复合索引，
-- 加速 listTrades 按 ret 排序/筛选的服务端查询。
--
-- 幂等：IF NOT EXISTS 保证重复执行安全。

CREATE INDEX IF NOT EXISTS idx_signal_test_trade_run_ret
    ON signal_test_trade (run_id, ret);
