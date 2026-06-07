# =====================================================================
# 20260607_create_signal_test_tables.ps1
#
# Create signal_test, signal_test_run, signal_test_trade tables.
#
# spec: docs/superpowers/specs/2026-06-07-signal-forward-stats-design/03-data-model.md
#
# Usage (from repo root):
#   powershell apps/server/migrations/20260607_create_signal_test_tables.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260607_create_signal_test_tables.sql"

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
Write-Host "==== Running migration: 20260607_create_signal_test_tables ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify tables exist ----
Write-Host ""
Write-Host "==== Verifying tables and indexes ===="

$signalTestCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'signal_test' AND table_schema = 'public';"
Write-Host "  signal_test table exists: $signalTestCount (expect 1)"

$signalTestRunCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'signal_test_run' AND table_schema = 'public';"
Write-Host "  signal_test_run table exists: $signalTestRunCount (expect 1)"

$signalTestTradeCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'signal_test_trade' AND table_schema = 'public';"
Write-Host "  signal_test_trade table exists: $signalTestTradeCount (expect 1)"

$idxRunCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_signal_test_run_test_created';"
Write-Host "  idx_signal_test_run_test_created exists: $idxRunCount (expect 1)"

$idxTradeRunCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_signal_test_trade_run_id';"
Write-Host "  idx_signal_test_trade_run_id exists: $idxTradeRunCount (expect 1)"

$idxTradeSignalCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_signal_test_trade_run_signal_date';"
Write-Host "  idx_signal_test_trade_run_signal_date exists: $idxTradeSignalCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($signalTestCount -ne 1)       { Write-Host "[FAIL] signal_test table not found"; $failed = $true }
if ($signalTestRunCount -ne 1)    { Write-Host "[FAIL] signal_test_run table not found"; $failed = $true }
if ($signalTestTradeCount -ne 1)  { Write-Host "[FAIL] signal_test_trade table not found"; $failed = $true }
if ($idxRunCount -ne 1)           { Write-Host "[FAIL] idx_signal_test_run_test_created not found"; $failed = $true }
if ($idxTradeRunCount -ne 1)      { Write-Host "[FAIL] idx_signal_test_trade_run_id not found"; $failed = $true }
if ($idxTradeSignalCount -ne 1)   { Write-Host "[FAIL] idx_signal_test_trade_run_signal_date not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: signal_test, signal_test_run, signal_test_trade created with indexes ===="
