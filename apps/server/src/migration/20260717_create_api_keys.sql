-- =====================================================================
-- 20260717_create_api_keys.sql
--
-- 用途: 创建 api_keys 表，用于存储用户 API 密钥信息。
--   字段包括: key_hash(哈希存储)、key_prefix(前缀展示)、
--   last_used_at(最近使用时间)、expires_at(过期时间)、revoked_at(吊销时间)。
--   外键关联 users 表，支持级联删除。
--
-- 幂等声明: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS。
-- =====================================================================

-- ---- api_keys ----
CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       character varying(36) NOT NULL,
  name          character varying(100) NOT NULL,
  key_hash      text NOT NULL,
  key_prefix    character varying(16) NOT NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_api_keys_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_api_keys_revoked
    CHECK (revoked_at IS NULL OR expires_at IS NULL OR revoked_at <= expires_at)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash) WHERE revoked_at IS NULL;
