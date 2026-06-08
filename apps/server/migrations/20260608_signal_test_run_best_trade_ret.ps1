# =====================================================================
# 20260608_signal_test_run_best_trade_ret.ps1
#
# Add best_trade_ret column to signal_test_run and backfill from
# signal_test_trade.
#
# Usage (from repo root):
#   powershell apps/server/migrations/20260608_signal_test_run_best_trade_ret.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260608_signal_test_run_best_trade_ret.sql"

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
Write-Host "==== Running migration: 20260608_signal_test_run_best_trade_ret ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$colCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test_run' AND column_name='best_trade_ret';"
Write-Host "  best_trade_ret column exists: $colCount (expect 1)"

$nullCount = Invoke-Scalar "SELECT count(*) FROM signal_test_run r WHERE EXISTS (SELECT 1 FROM signal_test_trade t WHERE t.run_id = r.id) AND r.best_trade_ret IS NULL;"
Write-Host "  runs with trades but NULL best_trade_ret: $nullCount (expect 0)"

# ---- Assertions ----
$failed = $false
if ($colCount -ne 1)  { Write-Host "[FAIL] best_trade_ret column not found"; $failed = $true }
if ($nullCount -ne 0) { Write-Host "[FAIL] backfill incomplete: $nullCount run(s) still have NULL best_trade_ret"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: best_trade_ret added and backfilled ===="
