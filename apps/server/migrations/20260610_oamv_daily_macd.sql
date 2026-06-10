-- =====================================================================
-- 20260610_oamv_daily_macd.sql
-- Add amv_dif/amv_dea/amv_macd columns to oamv_daily (market-level 0AMV
-- MACD, TDX-style 12/26/9, bar = 2*(DIF-DEA); computed by OamvService
-- full-series recompute after each sync).
-- Idempotent: ADD COLUMN IF NOT EXISTS. No backfill here (next sync with
-- overwrite recomputes the whole series and fills these columns).
-- Type double precision aligns with stock_amv_daily.amv_* columns.
-- =====================================================================
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS amv_dif double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS amv_dea double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS amv_macd double precision;
