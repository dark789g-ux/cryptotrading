-- =====================================================================
-- 20260625000003-create-money-flow-index.sql
--
-- 新建 money_flow_index 表：指数资金流向
-- spec: docs/superpowers/specs/2026-06-25-money-flow-refactor/02-data-model.md §2.3
-- =====================================================================

CREATE TABLE IF NOT EXISTS money_flow_index (
  id              BIGSERIAL     PRIMARY KEY,
  ts_code         VARCHAR(20)   NOT NULL,
  trade_date      VARCHAR(8)    NOT NULL,
  net_amount      NUMERIC(20,4),
  buy_lg_amount   NUMERIC(20,4),
  buy_md_amount   NUMERIC(20,4),
  buy_sm_amount   NUMERIC(20,4),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_money_flow_index_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_index_ts_date
  ON money_flow_index (ts_code, trade_date);
