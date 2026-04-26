ALTER TABLE a_share_daily_indicators
  ADD COLUMN IF NOT EXISTS brick double precision,
  ADD COLUMN IF NOT EXISTS brick_delta double precision,
  ADD COLUMN IF NOT EXISTS brick_xg boolean;
