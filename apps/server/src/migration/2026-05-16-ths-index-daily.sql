-- 2026-05-16 同花顺指数日线行情 + 指标表（spec: 2026-05-16-kline-moneyflow-subchart-design）
-- 执行（docker exec 格式）：
-- docker exec -i crypto-postgres psql -U cryptouser -d cryptodb < apps/server/src/migration/2026-05-16-ths-index-daily.sql

CREATE TABLE IF NOT EXISTS ths_index_daily_quotes (
  id              BIGSERIAL PRIMARY KEY,
  ts_code         VARCHAR(20)      NOT NULL,
  trade_date      VARCHAR(8)       NOT NULL,
  open            DOUBLE PRECISION,
  high            DOUBLE PRECISION,
  low             DOUBLE PRECISION,
  close           DOUBLE PRECISION,
  pre_close       DOUBLE PRECISION,
  change          DOUBLE PRECISION,
  pct_change      DOUBLE PRECISION,
  vol_hand        DOUBLE PRECISION,
  total_mv_wan    NUMERIC(20, 4),
  float_mv_wan    NUMERIC(20, 4),
  turnover_rate   DOUBLE PRECISION,
  updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ths_index_daily_quotes UNIQUE (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_ths_index_daily_quotes_tscode_tradedate
  ON ths_index_daily_quotes (ts_code, trade_date DESC);

CREATE TABLE IF NOT EXISTS ths_index_daily_indicators (
  id              BIGSERIAL PRIMARY KEY,
  ts_code         VARCHAR(20)      NOT NULL,
  trade_date      VARCHAR(8)       NOT NULL,
  ma5             DOUBLE PRECISION,
  ma30            DOUBLE PRECISION,
  ma60            DOUBLE PRECISION,
  ma120           DOUBLE PRECISION,
  ma240           DOUBLE PRECISION,
  dif             DOUBLE PRECISION,
  dea             DOUBLE PRECISION,
  macd            DOUBLE PRECISION,
  kdj_k           DOUBLE PRECISION,
  kdj_d           DOUBLE PRECISION,
  kdj_j           DOUBLE PRECISION,
  bbi             DOUBLE PRECISION,
  brick           DOUBLE PRECISION,
  brick_delta     DOUBLE PRECISION,
  brick_xg        BOOLEAN,
  updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ths_index_daily_indicators UNIQUE (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_ths_index_daily_indicators_tscode_tradedate
  ON ths_index_daily_indicators (ts_code, trade_date DESC);
