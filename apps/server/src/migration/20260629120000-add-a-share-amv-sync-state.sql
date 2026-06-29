-- 20260629120000 a_share_sync_states 增加 AMV dirty / calculated 列（个股 AMV 增量 dirty 续算，③-a）
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260629120000-add-a-share-amv-sync-state.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：
--   - 与 qfq_dirty_from_date / indicator_dirty_from_date 同型，nullable，ADD COLUMN IF NOT EXISTS 幂等可重跑。
--   - amv_dirty_from_date：daily_quote / 复权因子变动传导的 AMV 脏起点；AMV dirty 重算后清 NULL。
--   - amv_calculated_to_date：AMV 已算到的最新交易日。

ALTER TABLE a_share_sync_states ADD COLUMN IF NOT EXISTS amv_dirty_from_date varchar(8);
ALTER TABLE a_share_sync_states ADD COLUMN IF NOT EXISTS amv_calculated_to_date varchar(8);
