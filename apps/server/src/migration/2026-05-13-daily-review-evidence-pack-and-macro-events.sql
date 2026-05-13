-- Daily Review Tool-Calling Pipeline 数据层基础变更
-- 关联设计稿：doc/specs/2026-05-13-tool-calling-daily-review-design.md § 4.1 / § 4.2
-- (a) daily_review 表新增 3 列：evidence_pack / investigator_tool_calls / investigator_tool_call_count
-- (b) 新建 macro_events 表 + idx_macro_events_date 索引

-- (a) daily_review 表加列：纯加列、无 NOT NULL、jsonb 默认 NULL（禁止 default '{}'）
ALTER TABLE daily_review
  ADD COLUMN IF NOT EXISTS evidence_pack jsonb;

ALTER TABLE daily_review
  ADD COLUMN IF NOT EXISTS investigator_tool_calls jsonb;

ALTER TABLE daily_review
  ADD COLUMN IF NOT EXISTS investigator_tool_call_count int;

-- (b) macro_events 表
CREATE TABLE IF NOT EXISTS macro_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date  date NOT NULL,
  event_time  time NULL,
  title       varchar(255) NOT NULL,
  category    varchar(50)  NOT NULL,  -- monetary | fiscal | data | corporate
  importance  varchar(10)  NOT NULL,  -- low | mid | high
  detail      text NULL,
  source_url  varchar(500) NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_macro_events_date ON macro_events(event_date);

-- ============================================================================
-- 本地执行（docker exec 可执行脚本，遵守 CLAUDE.md 「数据库调整附 docker exec 脚本」 约束）
-- ============================================================================
-- docker exec -i crypto-postgres psql -U cryptouser -d cryptodb < apps/server/src/migration/2026-05-13-daily-review-evidence-pack-and-macro-events.sql
