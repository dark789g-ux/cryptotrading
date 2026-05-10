CREATE TABLE IF NOT EXISTS ths_index_catalog (
  ts_code     VARCHAR(20) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  count       INTEGER,
  exchange    VARCHAR(8) NOT NULL,
  list_date   VARCHAR(8),
  type        VARCHAR(4) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ths_index_catalog_type ON ths_index_catalog (type);
