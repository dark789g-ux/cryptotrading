-- =====================================================================
-- 20260616160000-create-us-index-amv-tables.sql
--
-- 美股指数活跃市值（AMV）：建 raw.us_index_amv_daily / us_index_constituent 两张表
--   raw.us_index_amv_daily   AMV 输出表（镜像 public.industry_amv_daily，ts_code → index_code）
--   raw.us_index_constituent 成分名单表（101 只 .NDX 成分；weight_pct 仅 top-25 有值，余 NULL）
--
-- 见 docs/superpowers/specs/2026-06-16-us-index-amv-design/02-data-model.md §1/§2
-- raw schema 已由 20260616120000-create-us-stocks.sql 建立，此处不再建 schema。
-- =====================================================================

-- ---- AMV 输出表（镜像 public.industry_amv_daily） ----
CREATE TABLE IF NOT EXISTS raw.us_index_amv_daily (
  id           bigserial PRIMARY KEY,
  index_code   character varying(16) NOT NULL,
  trade_date   character varying(8)  NOT NULL,
  amv_open     double precision,
  amv_high     double precision,
  amv_low      double precision,
  amv_close    double precision,
  amv_dif      double precision,
  amv_dea      double precision,
  amv_macd     double precision,
  amv_zdf      double precision,
  signal       smallint NOT NULL,
  member_count integer,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_index_amv_daily UNIQUE (index_code, trade_date),
  CONSTRAINT ck_us_index_amv_daily_signal CHECK (signal IN (-1, 0, 1))
);
CREATE INDEX IF NOT EXISTS ix_us_index_amv_daily_code_date
  ON raw.us_index_amv_daily (index_code, trade_date DESC);
CREATE INDEX IF NOT EXISTS ix_us_index_amv_daily_date_signal
  ON raw.us_index_amv_daily (trade_date, signal);

-- ---- 成分名单表 ----
CREATE TABLE IF NOT EXISTS raw.us_index_constituent (
  id          bigserial PRIMARY KEY,
  index_code  character varying(16) NOT NULL,
  ticker      character varying(16) NOT NULL,
  weight_pct  double precision,            -- 仅 top-25 有值，余 NULL（裸Σ不用，仅参考）
  name        character varying,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_index_constituent UNIQUE (index_code, ticker)
);
CREATE INDEX IF NOT EXISTS ix_us_index_constituent_code
  ON raw.us_index_constituent (index_code);
