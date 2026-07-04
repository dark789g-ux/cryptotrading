# =====================================================================
# 20260704_create_regime_backtest_tables.ps1
#
# Create regime_backtest_run, regime_backtest_daily and regime_backtest_trade tables.
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260704_create_regime_backtest_tables.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260704_create_regime_backtest_tables.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

function Invoke-Scalar([string]$sql) {
  $out = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c $sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql query failed (exit $LASTEXITCODE): $sql"
  }
  return [int](($out | Select-Object -First 1).Trim())
}

# ---- Execute migration ----
Write-Host "==== Running migration: 20260704_create_regime_backtest_tables ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify tables exist ----
Write-Host ""
Write-Host "==== Verifying tables and indexes ===="

$runCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'regime_backtest_run' AND table_schema = 'public';"
Write-Host "  regime_backtest_run table exists: $runCount (expect 1)"

$dailyCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'regime_backtest_daily' AND table_schema = 'public';"
Write-Host "  regime_backtest_daily table exists: $dailyCount (expect 1)"

$tradeCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'regime_backtest_trade' AND table_schema = 'public';"
Write-Host "  regime_backtest_trade table exists: $tradeCount (expect 1)"

$idxTradeBuyDateCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_regime_backtest_trade_run_buy_date';"
Write-Host "  idx_regime_backtest_trade_run_buy_date exists: $idxTradeBuyDateCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($runCount -ne 1)             { Write-Host "[FAIL] regime_backtest_run table not found"; $failed = $true }
if ($dailyCount -ne 1)           { Write-Host "[FAIL] regime_backtest_daily table not found"; $failed = $true }
if ($tradeCount -ne 1)            { Write-Host "[FAIL] regime_backtest_trade table not found"; $failed = $true }
if ($idxTradeBuyDateCount -ne 1) { Write-Host "[FAIL] idx_regime_backtest_trade_run_buy_date not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: regime_backtest_run, regime_backtest_daily, regime_backtest_trade created with indexes ===="
