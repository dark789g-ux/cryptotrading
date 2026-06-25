-- =====================================================================
-- 20260625000004-create-money-flow-ths-industries.sql
--
-- 新建 money_flow_ths_industries 表：同花顺行业资金流向
-- spec: docs/superpowers/specs/2026-06-25-money-flow-refactor/02-data-model.md §2.3
-- =====================================================================

CREATE TABLE IF NOT EXISTS money_flow_ths_industries (
  id              BIGSERIAL     PRIMARY KEY,
  ts_code         VARCHAR(20)   NOT NULL,
  trade_date      VARCHAR(8)    NOT NULL,
  industry        VARCHAR(64)   NOT NULL,
  pct_change      NUMERIC(20,4),
  net_buy_amount  NUMERIC(20,4),
  net_sell_amount NUMERIC(20,4),
  net_amount      NUMERIC(20,4),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_money_flow_ths_industries_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_ths_industries_ts_date
  ON money_flow_ths_industries (ts_code, trade_date);
