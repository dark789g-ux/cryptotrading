ALTER TABLE raw.daily_indicator
  ADD COLUMN IF NOT EXISTS vwap5 double precision,
  ADD COLUMN IF NOT EXISTS vwap10 double precision,
  ADD COLUMN IF NOT EXISTS vwap20 double precision;
