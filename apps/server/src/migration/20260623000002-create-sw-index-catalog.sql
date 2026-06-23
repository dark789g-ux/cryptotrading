-- 20260623000002 新建 sw_index_catalog 申万行业指数目录表（SW-T1）
-- spec: docs/superpowers/specs/2026-06-23-sw-index-integration-design/01-data-model.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260623000002-create-sw-index-catalog.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：
--   - 申万行业指数分一/二/三级，l1_* / l2_* / l3_* 冗余存各层级父链（便于按层级聚合查询）。
--   - member_count / published nullable（同步时若 Tushare 未返回则留 NULL）。
--   - level TS 联合类型 1|2|3，DB 列无 CHECK（与既有 index_daily_quotes.category 风格一致，
--     由同步 fetcher + service 保证取值）。
--   - CREATE TABLE / CREATE INDEX 均 IF NOT EXISTS，幂等可重跑。

CREATE TABLE IF NOT EXISTS sw_index_catalog (
  ts_code       VARCHAR(20)   PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  level         SMALLINT      NOT NULL,
  l1_code       VARCHAR(20),
  l1_name       VARCHAR(100),
  l2_code       VARCHAR(20),
  l2_name       VARCHAR(100),
  l3_code       VARCHAR(20),
  l3_name       VARCHAR(100),
  member_count  INTEGER,
  published     BOOLEAN,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sw_index_catalog_level ON sw_index_catalog (level);
