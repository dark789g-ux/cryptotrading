-- 可执行命令：
-- docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "CREATE TABLE IF NOT EXISTS a_share_filter_presets (id character varying PRIMARY KEY, name character varying NOT NULL UNIQUE, filters jsonb NOT NULL DEFAULT CAST('{}' AS jsonb), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());"

CREATE TABLE IF NOT EXISTS a_share_filter_presets (
  id character varying PRIMARY KEY,
  name character varying NOT NULL UNIQUE,
  filters jsonb NOT NULL DEFAULT CAST('{}' AS jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
