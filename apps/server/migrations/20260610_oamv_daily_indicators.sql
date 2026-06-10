-- =====================================================================
-- 20260610_oamv_daily_indicators.sql
-- Add ma5/ma30/ma60/ma120/ma240/kdj_k/kdj_d/kdj_j columns to oamv_daily
-- (market-level 0AMV MA and KDJ indicators; computed by OamvService
-- full-series recompute after each sync).
-- Idempotent: ADD COLUMN IF NOT EXISTS. No backfill here (next sync with
-- overwrite recomputes the whole series and fills these columns).
-- Type double precision aligns with existing amv_dif/amv_dea/amv_macd
-- columns and raw.daily_indicator ma5/kdj_k naming convention.
-- All columns nullable: NULL is valid for the warm-up head of the series.
-- =====================================================================
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma5    double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma30   double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma60   double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma120  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma240  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS kdj_k  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS kdj_d  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS kdj_j  double precision;
