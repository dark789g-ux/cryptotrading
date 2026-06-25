-- =====================================================================
-- 20260625000005-alter-money-flow-market.sql
--
-- 为 money_flow_market 表新增 buy_md_amount 列（中单净流入）
-- spec: docs/superpowers/specs/2026-06-25-money-flow-refactor/02-data-model.md §2.3
-- =====================================================================

ALTER TABLE money_flow_market
  ADD COLUMN IF NOT EXISTS buy_md_amount NUMERIC(20,4);
