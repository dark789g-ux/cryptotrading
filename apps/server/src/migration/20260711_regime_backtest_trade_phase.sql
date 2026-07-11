-- Add trade_phase column to regime_backtest_trade for Kelly sim/probe/live audit.
ALTER TABLE regime_backtest_trade
  ADD COLUMN IF NOT EXISTS trade_phase varchar(12) NULL;

CREATE INDEX IF NOT EXISTS idx_regime_backtest_trade_run_phase
  ON regime_backtest_trade (run_id, trade_phase);
