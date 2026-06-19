# =====================================================================
# 20260609_signal_test_trade_run_ret_index.ps1
#
# Create (run_id, ret) composite index on signal_test_trade for
# server-side sort/filter performance on the listTrades endpoint.
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260609_signal_test_trade_run_ret_index.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260609_signal_test_trade_run_ret_index.sql"

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
Write-Host "==== Running migration: 20260609_signal_test_trade_run_ret_index ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$idxCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE tablename='signal_test_trade' AND indexname='idx_signal_test_trade_run_ret';"
Write-Host "  idx_signal_test_trade_run_ret exists: $idxCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($idxCount -ne 1) { Write-Host "[FAIL] index not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: idx_signal_test_trade_run_ret created ===="
