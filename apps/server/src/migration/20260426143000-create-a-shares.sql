CREATE TABLE IF NOT EXISTS a_share_symbols (
  ts_code character varying PRIMARY KEY,
  symbol character varying NOT NULL,
  name character varying NOT NULL,
  area character varying,
  industry character varying,
  market character varying,
  exchange character varying,
  list_status character varying,
  list_date character varying,
  delist_date character varying,
  is_hs character varying,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS a_share_daily_quotes (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  open numeric(30, 10),
  high numeric(30, 10),
  low numeric(30, 10),
  close numeric(30, 10),
  pre_close numeric(30, 10),
  change numeric(30, 10),
  pct_chg numeric(30, 10),
  vol numeric(30, 10),
  amount numeric(30, 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_a_share_daily_quotes_code_date UNIQUE (ts_code, trade_date)
);

CREATE TABLE IF NOT EXISTS a_share_daily_metrics (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  turnover_rate numeric(30, 10),
  volume_ratio numeric(30, 10),
  pe numeric(30, 10),
  pb numeric(30, 10),
  total_mv numeric(30, 10),
  circ_mv numeric(30, 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_a_share_daily_metrics_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_a_share_symbols_symbol ON a_share_symbols (symbol);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_name ON a_share_symbols (name);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_market ON a_share_symbols (market);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_industry ON a_share_symbols (industry);
CREATE INDEX IF NOT EXISTS idx_a_share_daily_quotes_code_date ON a_share_daily_quotes (ts_code, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_a_share_daily_quotes_trade_date ON a_share_daily_quotes (trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_a_share_daily_metrics_code_date ON a_share_daily_metrics (ts_code, trade_date DESC);
