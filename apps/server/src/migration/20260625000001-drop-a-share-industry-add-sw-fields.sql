-- 20260625000001 a_share_symbols 删除旧 industry 列，新增申万三级行业字段
-- spec: docs/superpowers/specs/2026-06-23-sw-index-integration-design/01-data-model.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260625000001-drop-a-share-industry-add-sw-fields.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

-- 删除旧 industry 列及索引
ALTER TABLE a_share_symbols
  DROP COLUMN IF EXISTS industry;

DROP INDEX IF EXISTS idx_a_share_symbols_industry;

-- 新增申万三级行业字段
ALTER TABLE a_share_symbols
  ADD COLUMN IF NOT EXISTS sw_industry_l1_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sw_industry_l2_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sw_industry_l3_code VARCHAR(20);

-- 新建索引
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_sw_l1 ON a_share_symbols (sw_industry_l1_code);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_sw_l2 ON a_share_symbols (sw_industry_l2_code);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_sw_l3 ON a_share_symbols (sw_industry_l3_code);
