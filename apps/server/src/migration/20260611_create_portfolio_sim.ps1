# =====================================================================
# 20260611_create_portfolio_sim.ps1
#
# Create portfolio_sim_run, portfolio_sim_daily and portfolio_sim_fill tables.
#
# spec: portfolio-sim 03-data-model
#
# Usage (from repo root):
#   powershell apps/server/migrations/20260611_create_portfolio_sim.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260611_create_portfolio_sim.sql"

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
Write-Host "==== Running migration: 20260611_create_portfolio_sim ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify tables exist ----
Write-Host ""
Write-Host "==== Verifying tables and indexes ===="

$runCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'portfolio_sim_run' AND table_schema = 'public';"
Write-Host "  portfolio_sim_run table exists: $runCount (expect 1)"

$dailyCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'portfolio_sim_daily' AND table_schema = 'public';"
Write-Host "  portfolio_sim_daily table exists: $dailyCount (expect 1)"

$fillCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'portfolio_sim_fill' AND table_schema = 'public';"
Write-Host "  portfolio_sim_fill table exists: $fillCount (expect 1)"

$idxFillStatusCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_portfolio_sim_fill_run_status';"
Write-Host "  idx_portfolio_sim_fill_run_status exists: $idxFillStatusCount (expect 1)"

$idxFillBuyDateCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_portfolio_sim_fill_run_buy_date';"
Write-Host "  idx_portfolio_sim_fill_run_buy_date exists: $idxFillBuyDateCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($runCount -ne 1)           { Write-Host "[FAIL] portfolio_sim_run table not found"; $failed = $true }
if ($dailyCount -ne 1)         { Write-Host "[FAIL] portfolio_sim_daily table not found"; $failed = $true }
if ($fillCount -ne 1)          { Write-Host "[FAIL] portfolio_sim_fill table not found"; $failed = $true }
if ($idxFillStatusCount -ne 1) { Write-Host "[FAIL] idx_portfolio_sim_fill_run_status not found"; $failed = $true }
if ($idxFillBuyDateCount -ne 1) { Write-Host "[FAIL] idx_portfolio_sim_fill_run_buy_date not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: portfolio_sim_run, portfolio_sim_daily, portfolio_sim_fill created with indexes ===="
