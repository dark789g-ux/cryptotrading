-- =====================================================================
-- 20260626000001-add-buy-cols-to-money-flow-industries.sql
--
-- 为 money_flow_industries 表新增大/中/小单净流入列（申万行业资金流补齐）
-- =====================================================================

ALTER TABLE money_flow_industries
  ADD COLUMN IF NOT EXISTS buy_lg_amount NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS buy_md_amount NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS buy_sm_amount NUMERIC(20,4);
