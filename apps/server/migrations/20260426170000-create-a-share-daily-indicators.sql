CREATE TABLE IF NOT EXISTS a_share_daily_indicators (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  dif double precision,
  dea double precision,
  macd double precision,
  kdj_k double precision,
  kdj_d double precision,
  kdj_j double precision,
  bbi double precision,
  ma5 double precision,
  ma30 double precision,
  ma60 double precision,
  ma120 double precision,
  ma240 double precision,
  quote_volume_10 double precision,
  atr_14 double precision,
  loss_atr_14 double precision,
  low_9 double precision,
  high_9 double precision,
  stop_loss_pct double precision,
  risk_reward_ratio double precision,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_a_share_daily_indicators_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_a_share_daily_indicators_code_date
  ON a_share_daily_indicators (ts_code, trade_date DESC);
