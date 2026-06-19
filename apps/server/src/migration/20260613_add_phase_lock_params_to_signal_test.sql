-- =====================================================================
-- 20260613_add_phase_lock_params_to_signal_test.sql
-- Add phase_lock_params jsonb column to signal_test (phase_lock extra
-- params: initFactor / lockFactor / lookback).
-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable, no DEFAULT —
-- legacy rows stay phase_lock_params=NULL → reader falls back to all
-- defaults → zero behavioral drift. No CHECK (constraints in service).
-- =====================================================================
ALTER TABLE signal_test ADD COLUMN IF NOT EXISTS phase_lock_params jsonb;
