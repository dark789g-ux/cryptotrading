-- 申万指数活跃市值（AMV）日线宽表。spec 2026-06-28-ashares-index-amv-subplot-design.md §5.1

CREATE TABLE IF NOT EXISTS sw_amv_daily (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  amv_open double precision,
  amv_high double precision,
  amv_low double precision,
  amv_close double precision,
  amv_dif double precision,
  amv_dea double precision,
  amv_macd double precision,
  amv_zdf double precision,
  signal smallint NOT NULL,
  member_count integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sw_amv_daily_code_date UNIQUE (ts_code, trade_date),
  CONSTRAINT ck_sw_amv_daily_signal CHECK (signal IN (-1, 0, 1))
);

CREATE INDEX IF NOT EXISTS idx_sw_amv_daily_code_date
  ON sw_amv_daily (ts_code, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_sw_amv_daily_date_signal
  ON sw_amv_daily (trade_date, signal);
