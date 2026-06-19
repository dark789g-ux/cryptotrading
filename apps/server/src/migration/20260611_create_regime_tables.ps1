# =====================================================================
# 20260611_create_regime_tables.ps1
#
# Create regime_strategy_config and regime_daily_pick tables.
#
# spec: 0AMV regime engine M5 data layer
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260611_create_regime_tables.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260611_create_regime_tables.sql"

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
Write-Host "==== Running migration: 20260611_create_regime_tables ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify tables exist ----
Write-Host ""
Write-Host "==== Verifying tables and indexes ===="

$configCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'regime_strategy_config' AND table_schema = 'public';"
Write-Host "  regime_strategy_config table exists: $configCount (expect 1)"

$pickCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'regime_daily_pick' AND table_schema = 'public';"
Write-Host "  regime_daily_pick table exists: $pickCount (expect 1)"

$idxPickDateCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_regime_daily_pick_trade_date';"
Write-Host "  idx_regime_daily_pick_trade_date exists: $idxPickDateCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($configCount -ne 1)     { Write-Host "[FAIL] regime_strategy_config table not found"; $failed = $true }
if ($pickCount -ne 1)       { Write-Host "[FAIL] regime_daily_pick table not found"; $failed = $true }
if ($idxPickDateCount -ne 1) { Write-Host "[FAIL] idx_regime_daily_pick_trade_date not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: regime_strategy_config, regime_daily_pick created with indexes ===="
