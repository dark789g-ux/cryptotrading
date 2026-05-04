CREATE TABLE IF NOT EXISTS user_preferences (
  id character varying PRIMARY KEY,
  user_id character varying NOT NULL,
  key character varying NOT NULL,
  value jsonb NOT NULL DEFAULT CAST('{}' AS jsonb),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_preferences_user_key UNIQUE (user_id, key),
  CONSTRAINT fk_user_preferences_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences (user_id);
