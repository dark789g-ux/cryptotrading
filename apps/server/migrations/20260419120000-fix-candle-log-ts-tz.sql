-- backtest_candle_logs.ts: timestamp without time zone -> timestamptz
-- Existing rows stored Node-local (Asia/Shanghai) wall clock; reinterpret as +08 to get UTC instant.
-- Do NOT use current_setting('TimeZone'): session is UTC and would misinterpret values.

BEGIN;

ALTER TABLE backtest_candle_logs
  ALTER COLUMN ts TYPE timestamptz
  USING (ts AT TIME ZONE 'Asia/Shanghai');

COMMIT;
