-- 回滚 20260622120000：恢复旧表名，删新表
-- 注：大盘 catalog type='M' 行保留（无害，type 无 CHECK 约束；如需清理另行 DELETE）
-- 执行：
--   Get-Content -Raw apps/server/src/migration/20260622120000-create-unified-index-daily.down.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

BEGIN;

-- 仅当旧表备份存在时恢复原名（幂等）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ths_index_daily_quotes_legacy') THEN
    ALTER TABLE ths_index_daily_quotes_legacy RENAME TO ths_index_daily_quotes;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ths_index_daily_indicators_legacy') THEN
    ALTER TABLE ths_index_daily_indicators_legacy RENAME TO ths_index_daily_indicators;
  END IF;
END $$;

DROP TABLE IF EXISTS index_daily_quotes;
DROP TABLE IF EXISTS index_daily_indicators;

COMMIT;
