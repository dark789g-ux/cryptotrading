ALTER TABLE raw.daily_indicator
  ADD COLUMN IF NOT EXISTS obv5d double precision,
  ADD COLUMN IF NOT EXISTS obv10d double precision,
  ADD COLUMN IF NOT EXISTS obv20d double precision;

ALTER TABLE raw.fund_daily_indicator
  ADD COLUMN IF NOT EXISTS obv5d double precision,
  ADD COLUMN IF NOT EXISTS obv10d double precision,
  ADD COLUMN IF NOT EXISTS obv20d double precision;

ALTER TABLE index_daily_indicators
  ADD COLUMN IF NOT EXISTS obv5d double precision,
  ADD COLUMN IF NOT EXISTS obv10d double precision,
  ADD COLUMN IF NOT EXISTS obv20d double precision;

ALTER TABLE custom_index_daily_indicators
  ADD COLUMN IF NOT EXISTS obv5d double precision,
  ADD COLUMN IF NOT EXISTS obv10d double precision,
  ADD COLUMN IF NOT EXISTS obv20d double precision;
