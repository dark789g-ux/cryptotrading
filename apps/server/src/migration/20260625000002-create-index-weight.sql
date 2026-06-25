-- 20260625000002 新建 index_weight 指数成分股权重版本链表
-- spec: docs/superpowers/specs/2026-06-25-index-weight-version-list/02-data-model.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260625000002-create-index-weight.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：
--   - 版本链表：同一 (index_code, con_code) 按 effective_date 形成版本链，
--     expire_date 为 NULL 表示当前生效版本。
--   - weight nullable（部分数据源可能不返回权重）。
--   - CREATE TABLE / CREATE INDEX 均 IF NOT EXISTS，幂等可重跑。

CREATE TABLE IF NOT EXISTS index_weight (
  id              BIGSERIAL     PRIMARY KEY,
  index_code      VARCHAR(20)   NOT NULL,
  con_code        VARCHAR(20)   NOT NULL,
  effective_date  VARCHAR(8)    NOT NULL,
  expire_date     VARCHAR(8),
  weight          NUMERIC(20, 10),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(index_code, con_code, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_index_weight_lookup
  ON index_weight(index_code, con_code, effective_date);
CREATE INDEX IF NOT EXISTS idx_index_weight_active
  ON index_weight(index_code) WHERE expire_date IS NULL;
