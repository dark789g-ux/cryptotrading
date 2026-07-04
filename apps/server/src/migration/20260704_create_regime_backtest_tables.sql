-- =====================================================================
-- 20260704_create_regime_backtest_tables.sql
--
-- Create three tables for the regime backtest engine:
--   regime_backtest_run    -- one row per backtest run (config + aggregate metrics)
--   regime_backtest_daily  -- per-day NAV / cash / exposure timeseries
--   regime_backtest_trade  -- per-signal fill records (taken / skipped)
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- =====================================================================

-- ---- regime_backtest_run ----
CREATE TABLE IF NOT EXISTS regime_backtest_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime_config_id      uuid NULL REFERENCES regime_strategy_config(id) ON DELETE SET NULL,
  regime_config_version integer NOT NULL,
  name                  varchar(200) NOT NULL,
  note                  text NULL,
  config                jsonb NOT NULL,
  date_start            varchar(8) NOT NULL,
  date_end              varchar(8) NOT NULL,
  status                varchar(20) NOT NULL DEFAULT 'pending',
  phase                 varchar(20) NULL,
  progress_done         integer NOT NULL DEFAULT 0,
  progress_total        integer NOT NULL DEFAULT 0,
  final_nav             numeric NULL,
  total_ret             numeric NULL,
  annual_ret            numeric NULL,
  max_drawdown          numeric NULL,
  sharpe                numeric NULL,
  calmar                numeric NULL,
  daily_win_rate        numeric NULL,
  daily_kelly           numeric NULL,
  n_taken               integer NULL,
  n_skipped             integer NULL,
  total_costs           numeric NULL,
  error_message         text NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz NULL
);

-- ---- regime_backtest_daily ----
CREATE TABLE IF NOT EXISTS regime_backtest_daily (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES regime_backtest_run(id) ON DELETE CASCADE,
  trade_date      varchar(8) NOT NULL,
  nav             numeric NOT NULL,
  cash            numeric NOT NULL,
  daily_ret       numeric NOT NULL,
  exposure        numeric NOT NULL,
  position_count  integer NOT NULL,
  UNIQUE (run_id, trade_date)
);

-- ---- regime_backtest_trade ----
CREATE TABLE IF NOT EXISTS regime_backtest_trade (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES regime_backtest_run(id) ON DELETE CASCADE,
  signal_date      varchar(8) NOT NULL,
  buy_date         varchar(8) NOT NULL,
  exit_date        varchar(8) NULL,
  ts_code          varchar(20) NOT NULL,
  regime           varchar(10) NOT NULL,
  exit_mode        varchar(20) NOT NULL,
  status           varchar(10) NOT NULL,
  skip_reason      varchar(20) NULL,
  exit_reason      varchar(50) NULL,
  ret              numeric NULL,
  alloc            numeric NULL,
  costs_paid       numeric NULL,
  realized_ret_net numeric NULL
);

CREATE INDEX IF NOT EXISTS idx_regime_backtest_trade_run_buy_date
  ON regime_backtest_trade (run_id, buy_date);
