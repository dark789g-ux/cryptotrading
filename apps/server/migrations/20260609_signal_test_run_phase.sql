-- =====================================================================
-- 20260609_signal_test_run_phase.sql
-- Add phase column to signal_test_run (running-state stage marker).
-- Idempotent: ADD COLUMN IF NOT EXISTS. No backfill (legacy runs are
-- all terminal; phase only matters while status='running').
-- =====================================================================
ALTER TABLE signal_test_run ADD COLUMN IF NOT EXISTS phase varchar(16);
