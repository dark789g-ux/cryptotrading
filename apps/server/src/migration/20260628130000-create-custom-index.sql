-- 20260628130000 新建 custom_index_* 自定义指数表族
-- spec: docs/superpowers/specs/2026-06-28-custom-index-create-design/02-data-model.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260628130000-create-custom-index.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：CREATE TABLE / CREATE INDEX 均 IF NOT EXISTS，幂等可重跑。

-- ---------------------------------------------------------------------------
-- custom_index_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_definitions (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          VARCHAR(36)   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts_code          VARCHAR(24)   NOT NULL UNIQUE,
  name             VARCHAR(100)  NOT NULL,
  description      TEXT,
  index_type       VARCHAR(16)   NOT NULL CHECK (index_type IN ('price', 'total_return')),
  base_date        VARCHAR(8)    NOT NULL,
  base_point       NUMERIC(20,4) NOT NULL DEFAULT 1000,
  weight_method    VARCHAR(16)   NOT NULL CHECK (weight_method IN ('equal', 'float_mv', 'custom')),
  status           VARCHAR(16)   NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'computing', 'ready', 'failed')),
  compute_progress SMALLINT      CHECK (compute_progress IS NULL OR (compute_progress >= 0 AND compute_progress <= 100)),
  compute_stage    VARCHAR(64),
  latest_job_id    UUID          REFERENCES ml.jobs(id) ON DELETE SET NULL,
  last_error       TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_index_definitions_user_updated
  ON custom_index_definitions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_index_definitions_status_pending
  ON custom_index_definitions(status) WHERE status IN ('pending', 'computing');

-- ---------------------------------------------------------------------------
-- custom_index_weight_versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_weight_versions (
  id               BIGSERIAL     PRIMARY KEY,
  custom_index_id  UUID          NOT NULL REFERENCES custom_index_definitions(id) ON DELETE CASCADE,
  effective_date   VARCHAR(8)    NOT NULL,
  expire_date      VARCHAR(8),
  weight_method    VARCHAR(16)   NOT NULL CHECK (weight_method IN ('equal', 'float_mv', 'custom')),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(custom_index_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_custom_index_weight_versions_active
  ON custom_index_weight_versions(custom_index_id) WHERE expire_date IS NULL;

-- ---------------------------------------------------------------------------
-- custom_index_members
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_members (
  id          BIGSERIAL       PRIMARY KEY,
  version_id  BIGINT          NOT NULL REFERENCES custom_index_weight_versions(id) ON DELETE CASCADE,
  con_code    VARCHAR(20)     NOT NULL,
  weight      NUMERIC(20,10)  NOT NULL,
  UNIQUE(version_id, con_code)
);

CREATE INDEX IF NOT EXISTS idx_custom_index_members_version
  ON custom_index_members(version_id);

-- ---------------------------------------------------------------------------
-- custom_index_daily_quotes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_daily_quotes (
  custom_index_id  UUID              NOT NULL REFERENCES custom_index_definitions(id) ON DELETE CASCADE,
  trade_date       VARCHAR(8)        NOT NULL,
  open             DOUBLE PRECISION,
  high             DOUBLE PRECISION,
  low              DOUBLE PRECISION,
  close            DOUBLE PRECISION,
  pre_close        DOUBLE PRECISION,
  change           DOUBLE PRECISION,
  pct_change       DOUBLE PRECISION,
  vol_hand         DOUBLE PRECISION,
  amount           DOUBLE PRECISION,
  updated_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  PRIMARY KEY (custom_index_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_custom_index_daily_quotes_date
  ON custom_index_daily_quotes(custom_index_id, trade_date DESC);

-- ---------------------------------------------------------------------------
-- custom_index_daily_indicators
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_daily_indicators (
  id               BIGSERIAL         PRIMARY KEY,
  custom_index_id  UUID              NOT NULL REFERENCES custom_index_definitions(id) ON DELETE CASCADE,
  trade_date       VARCHAR(8)        NOT NULL,
  ma5              DOUBLE PRECISION,
  ma30             DOUBLE PRECISION,
  ma60             DOUBLE PRECISION,
  ma120            DOUBLE PRECISION,
  ma240            DOUBLE PRECISION,
  dif              DOUBLE PRECISION,
  dea              DOUBLE PRECISION,
  macd             DOUBLE PRECISION,
  kdj_k            DOUBLE PRECISION,
  kdj_d            DOUBLE PRECISION,
  kdj_j            DOUBLE PRECISION,
  bbi              DOUBLE PRECISION,
  brick            DOUBLE PRECISION,
  brick_delta      DOUBLE PRECISION,
  brick_xg         BOOLEAN,
  updated_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  UNIQUE(custom_index_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_custom_index_daily_indicators_lookup
  ON custom_index_daily_indicators(custom_index_id, trade_date);

-- ---------------------------------------------------------------------------
-- custom_index_money_flow
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_money_flow (
  custom_index_id  UUID              NOT NULL REFERENCES custom_index_definitions(id) ON DELETE CASCADE,
  trade_date       VARCHAR(8)        NOT NULL,
  net_amount       DOUBLE PRECISION,
  buy_lg_amount    DOUBLE PRECISION,
  buy_md_amount    DOUBLE PRECISION,
  buy_sm_amount    DOUBLE PRECISION,
  updated_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  PRIMARY KEY (custom_index_id, trade_date)
);

-- ---------------------------------------------------------------------------
-- custom_index_amv
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_index_amv (
  custom_index_id  UUID              NOT NULL REFERENCES custom_index_definitions(id) ON DELETE CASCADE,
  trade_date       VARCHAR(8)        NOT NULL,
  amv              DOUBLE PRECISION,
  amv_ma5          DOUBLE PRECISION,
  amv_ma10         DOUBLE PRECISION,
  amv_ma20         DOUBLE PRECISION,
  amv_ma30         DOUBLE PRECISION,
  amv_ma60         DOUBLE PRECISION,
  updated_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  PRIMARY KEY (custom_index_id, trade_date)
);
