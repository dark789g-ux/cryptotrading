-- =====================================================================
-- 20260616130000-create-us-index.sql
--
-- 美股指数二级 Tab（AkShare 数据源）：建 raw.us_index_* 两张表
--   raw.us_index_daily      指数不复权日线（无 qfq、无 adj_factor）
--   raw.us_index_indicator  标准技术指标（17 列逐字对齐 raw.us_daily_indicator）
--
-- 见 docs/superpowers/specs/2026-06-16-us-index-subtab-design/01-data-model.md
-- raw schema 已由 20260616120000-create-us-stocks.sql 建立，此处不再建 schema。
-- =====================================================================

-- ---- 指数不复权日线 ----
CREATE TABLE IF NOT EXISTS raw.us_index_daily (
  id bigserial PRIMARY KEY,
  index_code character varying(16) NOT NULL,
  trade_date character varying(8) NOT NULL,
  open numeric(30, 10),
  high numeric(30, 10),
  low numeric(30, 10),
  close numeric(30, 10),
  volume numeric(30, 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_index_daily UNIQUE (index_code, trade_date)
);
CREATE INDEX IF NOT EXISTS ix_us_index_daily_code ON raw.us_index_daily (index_code);
CREATE INDEX IF NOT EXISTS ix_us_index_daily_date ON raw.us_index_daily (trade_date);

-- ---- 指数技术指标（标准 TA 子集，17 列照搬个股 us_daily_indicator） ----
CREATE TABLE IF NOT EXISTS raw.us_index_indicator (
  id bigserial PRIMARY KEY,
  index_code character varying(16) NOT NULL,
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
  CONSTRAINT uq_us_index_indicator UNIQUE (index_code, trade_date)
);
CREATE INDEX IF NOT EXISTS ix_us_index_indicator_code ON raw.us_index_indicator (index_code);
CREATE INDEX IF NOT EXISTS ix_us_index_indicator_date ON raw.us_index_indicator (trade_date);
