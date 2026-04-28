CREATE TABLE IF NOT EXISTS users (
  id character varying PRIMARY KEY,
  email character varying NOT NULL,
  display_name character varying NOT NULL,
  password_hash text NOT NULL,
  role character varying NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users (is_active);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id character varying PRIMARY KEY,
  user_id character varying NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  user_agent text,
  ip character varying,
  CONSTRAINT fk_auth_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sessions_token_hash ON auth_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
  ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_invitations (
  id character varying PRIMARY KEY,
  email character varying NOT NULL,
  role character varying NOT NULL,
  token_hash text NOT NULL,
  created_by_user_id character varying NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_user_invitations_role CHECK (role IN ('admin', 'user')),
  CONSTRAINT fk_user_invitations_created_by_user
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_invitations_token_hash ON user_invitations (token_hash);
CREATE INDEX IF NOT EXISTS idx_user_invitations_created_by_user_id ON user_invitations (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_user_invitations_email_lower ON user_invitations (lower(email));
DROP INDEX IF EXISTS uq_user_invitations_open_email_lower;
CREATE INDEX IF NOT EXISTS idx_user_invitations_open_email_lower
  ON user_invitations (lower(email), expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE strategies ADD COLUMN IF NOT EXISTS user_id character varying;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS user_id character varying;
ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS user_id character varying;
ALTER TABLE symbol_presets ADD COLUMN IF NOT EXISTS user_id character varying;
ALTER TABLE a_share_filter_presets ADD COLUMN IF NOT EXISTS user_id character varying;

CREATE INDEX IF NOT EXISTS idx_strategies_user_created_at ON strategies (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategies_user_last_backtest_at ON strategies (user_id, last_backtest_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_user_created_at ON backtest_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_user_strategy_created_at ON backtest_runs (user_id, strategy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchlists_user_created_at ON watchlists (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_symbol_presets_user_created_at ON symbol_presets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a_share_filter_presets_user_created_at ON a_share_filter_presets (user_id, created_at DESC);
