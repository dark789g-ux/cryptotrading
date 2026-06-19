-- =====================================================================
-- 20260611_create_regime_tables.sql
--
-- Create two tables for the 0AMV regime engine:
--   regime_strategy_config  -- versioned strategy config per regime quadrant
--   regime_daily_pick       -- daily pick list keyed by trade_date + regime
--
-- spec: 0AMV regime engine M5 data layer
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- =====================================================================

-- ---- regime_strategy_config ----
CREATE TABLE IF NOT EXISTS regime_strategy_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     integer UNIQUE NOT NULL,
  status      varchar(10) NOT NULL,
  note        text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  config      jsonb NOT NULL
);

-- ---- regime_daily_pick ----
CREATE TABLE IF NOT EXISTS regime_daily_pick (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date     varchar(8) NOT NULL,
  regime         varchar(8) NOT NULL,
  config_version integer NULL,
  action         varchar(8) NOT NULL,
  ts_code        varchar(30) NULL,
  name           varchar(64) NULL,
  snapshot       jsonb NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date, config_version, ts_code)
);

CREATE INDEX IF NOT EXISTS idx_regime_daily_pick_trade_date
  ON regime_daily_pick (trade_date);
