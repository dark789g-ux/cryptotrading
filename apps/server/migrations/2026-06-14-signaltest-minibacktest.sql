-- =====================================================================
-- 2026-06-14-signaltest-minibacktest.sql
--
-- signal_test 迷你回测升级（spec 03 §3.5）：
--   1. signal_test 加 backtest_config jsonb（null = 不跑回测，存量行零漂移）
--   2. signal_test_run 加 11 个回测指标列（null = 该 run 未跑回测层）
--   3. 新建 signal_test_equity 逐日净值曲线表 + 唯一约束 + 索引
--
-- 全部 IF NOT EXISTS 幂等。numeric 列不限精度。无 CHECK（约束在 service）。
-- 时间口径：trade_date 为 varchar(8) YYYYMMDD（A 股口径，非 timestamptz）。
-- =====================================================================

-- ---- 1. signal_test.backtest_config ----
ALTER TABLE signal_test ADD COLUMN IF NOT EXISTS backtest_config jsonb;

-- ---- 2. signal_test_run 回测指标列（均 nullable）----
ALTER TABLE signal_test_run
  ADD COLUMN IF NOT EXISTS final_nav      numeric,
  ADD COLUMN IF NOT EXISTS total_ret      numeric,
  ADD COLUMN IF NOT EXISTS annual_ret     numeric,
  ADD COLUMN IF NOT EXISTS max_drawdown   numeric,
  ADD COLUMN IF NOT EXISTS sharpe         numeric,
  ADD COLUMN IF NOT EXISTS calmar         numeric,
  ADD COLUMN IF NOT EXISTS daily_win_rate numeric,
  ADD COLUMN IF NOT EXISTS daily_kelly    numeric,
  ADD COLUMN IF NOT EXISTS n_taken        integer,
  ADD COLUMN IF NOT EXISTS n_skipped      integer,
  ADD COLUMN IF NOT EXISTS total_costs    numeric;

-- ---- 3. signal_test_equity 逐日净值曲线表 ----
CREATE TABLE IF NOT EXISTS signal_test_equity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES signal_test_run(id) ON DELETE CASCADE,
  trade_date     varchar(8) NOT NULL,          -- YYYYMMDD
  nav            numeric NOT NULL,
  cash           numeric NOT NULL,
  daily_ret      numeric NOT NULL,
  exposure       numeric NOT NULL,             -- Σmv / nav
  position_count integer NOT NULL,
  CONSTRAINT uq_signal_test_equity_run_date UNIQUE (run_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_signal_test_equity_run
  ON signal_test_equity (run_id, trade_date);
