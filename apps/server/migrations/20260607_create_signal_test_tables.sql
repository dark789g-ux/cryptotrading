-- =====================================================================
-- 20260607_create_signal_test_tables.sql
--
-- Create three tables for the signal forward stats feature:
--   signal_test          -- test configuration (long-lived)
--   signal_test_run      -- per-run aggregate stats (historical)
--   signal_test_trade    -- per-trade detail records
--
-- spec: docs/superpowers/specs/2026-06-07-signal-forward-stats-design/03-data-model.md
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- =====================================================================

-- ---- signal_test (test configuration) ----
CREATE TABLE IF NOT EXISTS signal_test (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         character varying(100) NOT NULL,
  buy_conditions  jsonb NOT NULL,
  exit_mode    character varying(16) NOT NULL,
  horizon_n    integer,
  exit_conditions jsonb,
  max_hold     integer,
  universe     jsonb NOT NULL,
  date_start   character varying(8) NOT NULL,
  date_end     character varying(8) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- signal_test_run (per-run aggregate stats) ----
CREATE TABLE IF NOT EXISTS signal_test_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id           uuid NOT NULL REFERENCES signal_test(id) ON DELETE CASCADE,
  status            character varying(16) NOT NULL DEFAULT 'running',
  progress_scanned  integer NOT NULL DEFAULT 0,
  progress_total    integer NOT NULL DEFAULT 0,
  error_message     text,
  sample_count      integer,
  win_rate          numeric,
  avg_win           numeric,
  avg_loss          numeric,
  payoff_ratio      numeric,
  profit_factor     numeric,
  kelly_f           numeric,
  avg_hold_days     numeric,
  worst_trade_ret   numeric,
  filtered_count    integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_signal_test_run_test_created
  ON signal_test_run (test_id, created_at DESC);

-- ---- signal_test_trade (per-trade detail records) ----
CREATE TABLE IF NOT EXISTS signal_test_trade (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES signal_test_run(id) ON DELETE CASCADE,
  ts_code      character varying(30) NOT NULL,
  signal_date  character varying(8) NOT NULL,
  buy_date     character varying(8) NOT NULL,
  exit_date    character varying(8) NOT NULL,
  buy_price    numeric NOT NULL,
  exit_price   numeric NOT NULL,
  ret          numeric NOT NULL,
  hold_days    integer NOT NULL,
  exit_reason  character varying(16) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_test_trade_run_id
  ON signal_test_trade (run_id);

CREATE INDEX IF NOT EXISTS idx_signal_test_trade_run_signal_date
  ON signal_test_trade (run_id, signal_date);
