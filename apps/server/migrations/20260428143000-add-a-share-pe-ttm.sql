ALTER TABLE IF EXISTS a_share_daily_metrics
  ADD COLUMN IF NOT EXISTS pe_ttm numeric(30, 10);
