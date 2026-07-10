-- Add rank audit columns to regime_backtest_trade for Top1 ranking.
ALTER TABLE regime_backtest_trade
  ADD COLUMN IF NOT EXISTS rank integer NULL,
  ADD COLUMN IF NOT EXISTS rank_field varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS rank_value numeric NULL;

CREATE INDEX IF NOT EXISTS idx_regime_backtest_trade_run_signal_rank
  ON regime_backtest_trade (run_id, signal_date, rank);
