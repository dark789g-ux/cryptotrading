-- =====================================================================
-- 20260616120000-create-us-stocks.sql
--
-- 美股 Tab（AkShare 数据源）：建 raw.us_* 四张表
--   raw.us_symbol          精选清单 + tracked 标记位（CSV 播种）
--   raw.us_daily_quote     不复权日线 + 派生前复权 qfq_*
--   raw.us_adj_factor      派生复权因子（qfq_close/raw_close）
--   raw.us_daily_indicator 标准技术指标（输入 qfq）
--
-- 见 docs/superpowers/specs/2026-06-16-us-stocks-tab-design/03-data-model.md
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS raw;

-- ---- 精选标的清单 ----
CREATE TABLE IF NOT EXISTS raw.us_symbol (
  id bigserial PRIMARY KEY,
  ticker character varying NOT NULL,
  name character varying,
  theme character varying,
  stock_type character varying,
  tracked boolean NOT NULL DEFAULT false,
  list_date character varying(8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_symbol_ticker UNIQUE (ticker)
);
CREATE INDEX IF NOT EXISTS idx_us_symbol_tracked ON raw.us_symbol (tracked);

-- ---- 不复权日线 + 派生前复权 ----
CREATE TABLE IF NOT EXISTS raw.us_daily_quote (
  id bigserial PRIMARY KEY,
  ticker character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  open numeric(30, 10),
  high numeric(30, 10),
  low numeric(30, 10),
  close numeric(30, 10),
  pre_close numeric(30, 10),
  pct_chg numeric(30, 10),
  volume numeric(30, 10),
  qfq_open numeric(30, 10),
  qfq_high numeric(30, 10),
  qfq_low numeric(30, 10),
  qfq_close numeric(30, 10),
  qfq_pre_close numeric(30, 10),
  qfq_pct_chg numeric(30, 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_daily_quote_ticker_date UNIQUE (ticker, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_us_daily_quote_ticker_date ON raw.us_daily_quote (ticker, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_us_daily_quote_trade_date ON raw.us_daily_quote (trade_date DESC);

-- ---- 派生复权因子 ----
CREATE TABLE IF NOT EXISTS raw.us_adj_factor (
  id bigserial PRIMARY KEY,
  ticker character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  adj_factor numeric(30, 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_adj_factor_ticker_date UNIQUE (ticker, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_us_adj_factor_ticker_date ON raw.us_adj_factor (ticker, trade_date DESC);

-- ---- 技术指标（标准 TA 子集，输入 qfq） ----
CREATE TABLE IF NOT EXISTS raw.us_daily_indicator (
  id bigserial PRIMARY KEY,
  ticker character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  ma5 double precision,
  ma30 double precision,
  ma60 double precision,
  ma120 double precision,
  ma240 double precision,
  bbi double precision,
  kdj_k double precision,
  kdj_d double precision,
  kdj_j double precision,
  dif double precision,
  dea double precision,
  macd double precision,
  atr_14 double precision,
  low_9 double precision,
  high_9 double precision,
  stop_loss_pct double precision,
  risk_reward_ratio double precision,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_daily_indicator_ticker_date UNIQUE (ticker, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_us_daily_indicator_ticker_date ON raw.us_daily_indicator (ticker, trade_date DESC);
