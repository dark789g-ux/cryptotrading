-- 20260701100000 新建 ETF 数据表族
-- spec: plans/pcf-nested-leaf.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260701100000-create-etf-tables.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：CREATE TABLE / CREATE INDEX 均 IF NOT EXISTS，幂等可重跑。

-- ---------------------------------------------------------------------------
-- raw.etf_symbol  （ETF 目录 / 种子清单）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.etf_symbol (
  id                BIGSERIAL       PRIMARY KEY,
  ts_code           VARCHAR(16)     NOT NULL,
  name              VARCHAR(100)    NOT NULL,
  exchange          VARCHAR(4)      NOT NULL CHECK (exchange IN ('SH', 'SZ')),
  fund_type         VARCHAR(32),
  manager           VARCHAR(100),
  index_code        VARCHAR(20),    -- 跟踪指数代码
  publish_iopv      BOOLEAN         NOT NULL DEFAULT FALSE,
  tracked           BOOLEAN         NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(ts_code)
);

CREATE INDEX IF NOT EXISTS idx_etf_symbol_exchange
  ON raw.etf_symbol(exchange);

-- ---------------------------------------------------------------------------
-- raw.etf_pcf  （PCF 申购赎回清单：头 + 成分股）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.etf_pcf (
  id                BIGSERIAL       PRIMARY KEY,
  ts_code           VARCHAR(16)     NOT NULL,
  trade_date        VARCHAR(8)      NOT NULL,
  fund_name         VARCHAR(100),
  manager           VARCHAR(100),
  fund_type         VARCHAR(32),
  index_code        VARCHAR(20),
  creation_unit     NUMERIC(20,4),
  max_cash_ratio    NUMERIC(20,4),
  publish_iopv      BOOLEAN,
  con_code          VARCHAR(16)     NOT NULL DEFAULT '',
  con_name          VARCHAR(100),
  quantity          NUMERIC(20,4),
  subst_flag        VARCHAR(10),
  premium_rate      NUMERIC(20,4),
  discount_rate     NUMERIC(20,4),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(ts_code, trade_date, con_code)
);

CREATE INDEX IF NOT EXISTS idx_etf_pcf_code_date
  ON raw.etf_pcf(ts_code, trade_date);
CREATE INDEX IF NOT EXISTS idx_etf_pcf_date
  ON raw.etf_pcf(trade_date);

-- ---------------------------------------------------------------------------
-- raw.fund_daily  （ETF 日线行情，仿 raw.daily_quote）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.fund_daily (
  id                BIGSERIAL       PRIMARY KEY,
  ts_code           VARCHAR(16)     NOT NULL,
  trade_date        VARCHAR(8)      NOT NULL,
  open              NUMERIC(30,10),
  high              NUMERIC(30,10),
  low               NUMERIC(30,10),
  close             NUMERIC(30,10),
  pre_close         NUMERIC(30,10),
  change_val        NUMERIC(30,10),  -- 涨跌额（避免保留字 change）
  pct_chg           NUMERIC(30,10),
  vol               NUMERIC(30,10),  -- 成交量（手）
  amount            NUMERIC(30,10),  -- 成交额（千元）
  adj_factor        NUMERIC(20,6),
  qfq_open          NUMERIC(30,10),
  qfq_high          NUMERIC(30,10),
  qfq_low           NUMERIC(30,10),
  qfq_close         NUMERIC(30,10),
  qfq_pre_close     NUMERIC(30,10),
  qfq_change_val    NUMERIC(30,10),
  qfq_pct_chg       NUMERIC(30,10),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_daily_code
  ON raw.fund_daily(ts_code);
CREATE INDEX IF NOT EXISTS idx_fund_daily_date
  ON raw.fund_daily(trade_date);

-- ---------------------------------------------------------------------------
-- raw.fund_daily_indicator  （ETF K 线技术指标，仿 raw.daily_indicator）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.fund_daily_indicator (
  id                BIGSERIAL       PRIMARY KEY,
  ts_code           VARCHAR(16)     NOT NULL,
  trade_date        VARCHAR(8)      NOT NULL,
  dif               DOUBLE PRECISION,
  dea               DOUBLE PRECISION,
  macd              DOUBLE PRECISION,
  kdj_k             DOUBLE PRECISION,
  kdj_d             DOUBLE PRECISION,
  kdj_j             DOUBLE PRECISION,
  bbi               DOUBLE PRECISION,
  ma5               DOUBLE PRECISION,
  ma30              DOUBLE PRECISION,
  ma60              DOUBLE PRECISION,
  ma120             DOUBLE PRECISION,
  ma240             DOUBLE PRECISION,
  quote_volume_10   DOUBLE PRECISION,
  atr_14            DOUBLE PRECISION,
  loss_atr_14       DOUBLE PRECISION,
  low_9             DOUBLE PRECISION,
  high_9            DOUBLE PRECISION,
  stop_loss_pct     DOUBLE PRECISION,
  risk_reward_ratio DOUBLE PRECISION,
  brick             DOUBLE PRECISION,
  brick_delta       DOUBLE PRECISION,
  brick_xg          BOOLEAN,
  roc10             DOUBLE PRECISION,
  roc20             DOUBLE PRECISION,
  roc60             DOUBLE PRECISION,
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_daily_indicator_code
  ON raw.fund_daily_indicator(ts_code);

-- ---------------------------------------------------------------------------
-- raw.fund_amv_daily  （ETF AMV 活跃市值，同构 sw_amv_daily）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.fund_amv_daily (
  id                BIGSERIAL       PRIMARY KEY,
  ts_code           VARCHAR(16)     NOT NULL,
  trade_date        VARCHAR(8)      NOT NULL,
  amv_open          DOUBLE PRECISION,
  amv_high          DOUBLE PRECISION,
  amv_low           DOUBLE PRECISION,
  amv_close         DOUBLE PRECISION,
  amv_dif           DOUBLE PRECISION,
  amv_dea           DOUBLE PRECISION,
  amv_macd          DOUBLE PRECISION,
  amv_zdf           DOUBLE PRECISION,
  signal            SMALLINT        NOT NULL DEFAULT 0,
  member_count      INTEGER,
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_amv_daily_code_date
  ON raw.fund_amv_daily(ts_code, trade_date);
CREATE INDEX IF NOT EXISTS idx_fund_amv_daily_date_signal
  ON raw.fund_amv_daily(trade_date, signal);

-- ---------------------------------------------------------------------------
-- money_flow_etf  （ETF 资金净流入，同构 money_flow_industries）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money_flow_etf (
  id                BIGSERIAL       PRIMARY KEY,
  ts_code           VARCHAR(16)     NOT NULL,
  trade_date        VARCHAR(8)      NOT NULL,
  pct_change        NUMERIC(20,4),
  net_buy_amount    NUMERIC(20,4),
  net_sell_amount   NUMERIC(20,4),
  net_amount        NUMERIC(20,4),
  buy_lg_amount     NUMERIC(20,4),
  buy_md_amount     NUMERIC(20,4),
  buy_sm_amount     NUMERIC(20,4),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_etf_code_date
  ON money_flow_etf(ts_code, trade_date);
CREATE INDEX IF NOT EXISTS idx_money_flow_etf_date
  ON money_flow_etf(trade_date);
