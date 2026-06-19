# =====================================================================
# 20260613_add_band_lock_params_to_signal_test.ps1
#
# Add band_lock_params jsonb column to signal_test (trailing_lock extra params).
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260613_add_band_lock_params_to_signal_test.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260613_add_band_lock_params_to_signal_test.sql"

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
Write-Host "==== Running migration: 20260613_add_band_lock_params_to_signal_test ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$colCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test' AND column_name='band_lock_params';"
Write-Host "  band_lock_params column exists: $colCount (expect 1)"

# data_type should be jsonb
$jsonbCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test' AND column_name='band_lock_params' AND data_type='jsonb';"
Write-Host "  band_lock_params is jsonb: $jsonbCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($colCount -ne 1) { Write-Host "[FAIL] band_lock_params column not found"; $failed = $true }
if ($jsonbCount -ne 1) { Write-Host "[FAIL] band_lock_params is not jsonb"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed ===="
