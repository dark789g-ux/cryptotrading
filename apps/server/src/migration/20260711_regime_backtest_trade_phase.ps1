# =====================================================================
# 20260711_regime_backtest_trade_phase.ps1
#
# Add trade_phase column to regime_backtest_trade for Kelly
# simulation / probe / live audit.
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260711_regime_backtest_trade_phase.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260711_regime_backtest_trade_phase.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

Write-Host "==== Running migration: 20260711_regime_backtest_trade_phase ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== Verifying column exists ===="
$columns = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c @"
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'regime_backtest_trade'
  AND column_name = 'trade_phase';
"@
if ($LASTEXITCODE -ne 0) {
  throw "psql verify failed"
}

$found = @($columns | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
Write-Host "  found columns: $($found -join ', ')"
if ($found -notcontains 'trade_phase') {
  throw "Expected column missing: trade_phase"
}

Write-Host ""
Write-Host "==== Migration complete ===="
