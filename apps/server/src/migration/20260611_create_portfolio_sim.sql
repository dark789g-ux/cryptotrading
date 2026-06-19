-- =====================================================================
-- 20260611_create_portfolio_sim.sql
--
-- Create three tables for the portfolio-level simulator:
--   portfolio_sim_run    -- one row per simulation run (config snapshot + aggregate metrics)
--   portfolio_sim_daily  -- per-day NAV / cash / exposure timeseries
--   portfolio_sim_fill   -- per-signal fill records (taken / skipped)
--
-- spec: portfolio-sim 03-data-model
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- =====================================================================

-- ---- portfolio_sim_run (one row per simulation) ----
CREATE TABLE IF NOT EXISTS portfolio_sim_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(100) NOT NULL,
  note            text NULL,
  config          jsonb NOT NULL,
  status          varchar(16) NOT NULL DEFAULT 'pending',
  phase           varchar(16) NULL,
  progress_done   integer NOT NULL DEFAULT 0,
  progress_total  integer NOT NULL DEFAULT 0,
  error_message   text NULL,
  final_nav       numeric NULL,
  total_ret       numeric NULL,
  annual_ret      numeric NULL,
  max_drawdown    numeric NULL,
  sharpe          numeric NULL,
  calmar          numeric NULL,
  daily_win_rate  numeric NULL,
  daily_kelly     numeric NULL,
  n_taken         integer NULL,
  n_skipped       integer NULL,
  total_costs     numeric NULL,
  anchor_check    jsonb NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz NULL
);

-- ---- portfolio_sim_daily (per-day timeseries) ----
CREATE TABLE IF NOT EXISTS portfolio_sim_daily (
  id                 bigserial PRIMARY KEY,
  run_id             uuid NOT NULL REFERENCES portfolio_sim_run(id) ON DELETE CASCADE,
  trade_date         varchar(8) NOT NULL,
  nav                numeric NOT NULL,
  cash               numeric NOT NULL,
  daily_ret          numeric NOT NULL,
  exposure           numeric NOT NULL,
  position_count     integer NOT NULL,
  strategy_exposure  jsonb NOT NULL,
  UNIQUE (run_id, trade_date)
);

-- ---- portfolio_sim_fill (per-signal fill records) ----
CREATE TABLE IF NOT EXISTS portfolio_sim_fill (
  id                bigserial PRIMARY KEY,
  run_id            uuid NOT NULL REFERENCES portfolio_sim_run(id) ON DELETE CASCADE,
  source_run_id     uuid NOT NULL,
  source_label      varchar(50) NOT NULL,
  ts_code           varchar(30) NOT NULL,
  signal_date       varchar(8) NOT NULL,
  buy_date          varchar(8) NOT NULL,
  status            varchar(8) NOT NULL,
  skip_reason       varchar(16) NULL,
  rank_field        varchar(16) NULL,
  rank_value        numeric NULL,
  weight_entry      numeric NULL,
  alloc             numeric NULL,
  exit_date         varchar(8) NULL,
  realized_ret_net  numeric NULL,
  costs_paid        numeric NULL
);

CREATE INDEX IF NOT EXISTS idx_portfolio_sim_fill_run_status
  ON portfolio_sim_fill (run_id, status);

CREATE INDEX IF NOT EXISTS idx_portfolio_sim_fill_run_buy_date
  ON portfolio_sim_fill (run_id, buy_date);
