# =====================================================================
# 20260609_create_signal_rolling_indicator.ps1
#
# Create signal_rolling_indicator table and add signal_rolling_dirty_from_date
# column to a_share_sync_states (for "bottom high-volume limit-up" replication).
#
# Usage (from repo root):
#   powershell apps/server/migrations/20260609_create_signal_rolling_indicator.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260609_create_signal_rolling_indicator.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

# Run a SQL query and return a scalar integer result
function Invoke-Scalar([string]$sql) {
  $out = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c $sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql query failed (exit $LASTEXITCODE): $sql"
  }
  return [int](($out | Select-Object -First 1).Trim())
}

# ---- Execute migration ----
Write-Host "==== Running migration: 20260609_create_signal_rolling_indicator ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$tableCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='signal_rolling_indicator';"
Write-Host "  signal_rolling_indicator table exists: $tableCount (expect 1)"

$colCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='a_share_sync_states' AND column_name='signal_rolling_dirty_from_date';"
Write-Host "  signal_rolling_dirty_from_date column exists: $colCount (expect 1)"

$idxCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname='idx_signal_rolling_indicator_code_date';"
Write-Host "  idx_signal_rolling_indicator_code_date exists: $idxCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($tableCount -ne 1) { Write-Host "[FAIL] signal_rolling_indicator table not found"; $failed = $true }
if ($colCount -ne 1)   { Write-Host "[FAIL] signal_rolling_dirty_from_date column not found"; $failed = $true }
if ($idxCount -ne 1)   { Write-Host "[FAIL] idx_signal_rolling_indicator_code_date not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: signal_rolling_indicator created, dirty column added ===="
