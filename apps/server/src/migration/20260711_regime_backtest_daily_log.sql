-- Daily audit log for regime backtest (per-day regime, entries/exits, cooldown).
CREATE TABLE IF NOT EXISTS regime_backtest_daily_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES regime_backtest_run(id) ON DELETE CASCADE,
  trade_date varchar(8) NOT NULL,
  nav numeric NOT NULL,
  cash numeric NOT NULL,
  regime varchar(16) NOT NULL DEFAULT 'unknown',
  frozen_reason varchar(24) NULL,
  trade_phase varchar(12) NULL,
  entries_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  exits_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_symbols_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  in_cooldown boolean NOT NULL DEFAULT false,
  cooldown_duration int NULL,
  cooldown_remaining int NULL,
  consec_losses int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_regime_backtest_daily_log_run_date
  ON regime_backtest_daily_log (run_id, trade_date);

CREATE INDEX IF NOT EXISTS idx_regime_backtest_daily_log_run_id
  ON regime_backtest_daily_log (run_id);
