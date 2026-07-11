# =====================================================================
# 20260711_regime_backtest_daily_log.ps1
#
# Create regime_backtest_daily_log table for per-day audit trail.
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260711_regime_backtest_daily_log.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260711_regime_backtest_daily_log.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

Write-Host "==== Running migration: 20260711_regime_backtest_daily_log ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== Verifying table exists ===="
$tables = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c @"
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'regime_backtest_daily_log';
"@
if ($LASTEXITCODE -ne 0) {
  throw "psql verify failed"
}

$found = @($tables | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
Write-Host "  found tables: $($found -join ', ')"
if ($found -notcontains 'regime_backtest_daily_log') {
  throw "Expected table missing: regime_backtest_daily_log"
}

Write-Host ""
Write-Host "==== Migration complete ===="
