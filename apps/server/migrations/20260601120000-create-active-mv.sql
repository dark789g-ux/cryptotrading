-- =====================================================================
-- 20260601120000-create-active-mv.sql
--
-- 活跃市值（Active MV / AMV）阶段 1：建个股 / 行业两张宽表。
-- spec docs/superpowers/specs/2026-06-01-active-mv-stock-industry-design.md §5
--
-- 索引说明：
--  - UNIQUE(ts_code, trade_date)：upsert 冲突键
--  - INDEX(ts_code, trade_date DESC)：单标的取最近 N 日
--  - INDEX(trade_date, signal)：signals?tradeDate= 单日扫全市场（避免全表扫描）
--  - CHECK(signal IN (-1,0,1))：三态信号约束
-- =====================================================================

-- ---- 个股活跃市值 ----
CREATE TABLE IF NOT EXISTS stock_amv_daily (
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
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_amv_daily_code_date UNIQUE (ts_code, trade_date),
  CONSTRAINT ck_stock_amv_daily_signal CHECK (signal IN (-1, 0, 1))
);

CREATE INDEX IF NOT EXISTS idx_stock_amv_daily_code_date
  ON stock_amv_daily (ts_code, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_stock_amv_daily_date_signal
  ON stock_amv_daily (trade_date, signal);

-- ---- 行业活跃市值（多 member_count 列）----
CREATE TABLE IF NOT EXISTS industry_amv_daily (
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
  CONSTRAINT uq_industry_amv_daily_code_date UNIQUE (ts_code, trade_date),
  CONSTRAINT ck_industry_amv_daily_signal CHECK (signal IN (-1, 0, 1))
);

CREATE INDEX IF NOT EXISTS idx_industry_amv_daily_code_date
  ON industry_amv_daily (ts_code, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_industry_amv_daily_date_signal
  ON industry_amv_daily (trade_date, signal);
