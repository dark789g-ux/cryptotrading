CREATE TABLE IF NOT EXISTS daily_review (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date         VARCHAR(8)  NOT NULL,
  status             VARCHAR(16) NOT NULL,
  snapshot           JSONB,
  article_md         TEXT,
  reasoning_content  TEXT,
  llm_model          VARCHAR(64),
  token_usage        JSONB,
  error_message      TEXT,
  created_by_id      UUID         NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_review_trade_date ON daily_review(trade_date);
CREATE INDEX IF NOT EXISTS idx_daily_review_status ON daily_review(status);
CREATE INDEX IF NOT EXISTS idx_daily_review_created_at ON daily_review(created_at DESC);
