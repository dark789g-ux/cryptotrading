# =====================================================================
# 20260609_signal_test_run_phase.ps1
#
# Add phase column to signal_test_run (running-state stage marker).
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260609_signal_test_run_phase.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260609_signal_test_run_phase.sql"

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
Write-Host "==== Running migration: 20260609_signal_test_run_phase ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$colCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test_run' AND column_name='phase';"
Write-Host "  phase column exists: $colCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($colCount -ne 1) { Write-Host "[FAIL] phase column not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed ===="
