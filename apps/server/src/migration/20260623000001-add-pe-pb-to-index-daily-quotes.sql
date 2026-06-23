-- 20260623000001 index_daily_quotes 增加 pe / pb 估值列（申万行业指数）
-- spec: docs/superpowers/specs/2026-06-23-sw-index-integration-design/01-data-model.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260623000001-add-pe-pb-to-index-daily-quotes.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：
--   - pe / pb 均 nullable。申万（category='sw'）填值；
--     market/industry/concept 合法 NULL（指数本身无 PE/PB 概念）。
--   - 用 ADD COLUMN IF NOT EXISTS，幂等可重跑。

ALTER TABLE index_daily_quotes ADD COLUMN IF NOT EXISTS pe double precision;
ALTER TABLE index_daily_quotes ADD COLUMN IF NOT EXISTS pb double precision;
