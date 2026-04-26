CREATE TABLE IF NOT EXISTS a_share_adj_factors (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  adj_factor numeric(30, 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_a_share_adj_factors_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_a_share_adj_factors_code_date
  ON a_share_adj_factors (ts_code, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_a_share_adj_factors_trade_date
  ON a_share_adj_factors (trade_date DESC);

ALTER TABLE a_share_daily_quotes
  ADD COLUMN IF NOT EXISTS qfq_open numeric(30, 10),
  ADD COLUMN IF NOT EXISTS qfq_high numeric(30, 10),
  ADD COLUMN IF NOT EXISTS qfq_low numeric(30, 10),
  ADD COLUMN IF NOT EXISTS qfq_close numeric(30, 10),
  ADD COLUMN IF NOT EXISTS qfq_pre_close numeric(30, 10),
  ADD COLUMN IF NOT EXISTS qfq_change numeric(30, 10),
  ADD COLUMN IF NOT EXISTS qfq_pct_chg numeric(30, 10);
