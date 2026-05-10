-- 将所有 created_at / updated_at 等时间列从 timestamp without time zone 转为 timestamptz
-- 历史数据按 UTC 解释，避免按 Node 本地 TZ 重新解析
-- 执行：docker exec -i crypto-postgres psql -U cryptouser -d cryptodb < timestamptz-fix.sql

BEGIN;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
      AND column_name IN ('created_at', 'updated_at', 'last_seen_at', 'expires_at',
                          'revoked_at', 'accepted_at', 'completed_at', 'last_backtest_at',
                          'entry_time', 'exit_time', 'open_time', 'close_time')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
      rec.table_schema, rec.table_name, rec.column_name, rec.column_name
    );
    RAISE NOTICE '已转换 %.% -> timestamptz', rec.table_name, rec.column_name;
  END LOOP;
END $$;

COMMIT;
