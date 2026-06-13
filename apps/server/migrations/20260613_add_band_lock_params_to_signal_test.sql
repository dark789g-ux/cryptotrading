-- =====================================================================
-- 20260613_add_band_lock_params_to_signal_test.sql
-- Add band_lock_params jsonb column to signal_test (trailing_lock extra
-- params: stopRatio / floorRatio / floorEnabled / ma5RequireDown).
-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable, no DEFAULT —
-- legacy rows stay band_lock_params=NULL → reader falls back to all
-- defaults → zero behavioral drift. No CHECK (constraints in service).
-- =====================================================================
ALTER TABLE signal_test ADD COLUMN IF NOT EXISTS band_lock_params jsonb;
