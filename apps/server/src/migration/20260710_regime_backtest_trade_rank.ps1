# =====================================================================
# 20260710_regime_backtest_trade_rank.ps1
#
# Add rank / rank_field / rank_value columns to regime_backtest_trade
# for Top1 ranking audit.
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260710_regime_backtest_trade_rank.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260710_regime_backtest_trade_rank.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

Write-Host "==== Running migration: 20260710_regime_backtest_trade_rank ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== Verifying columns exist ===="
$columns = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c @"
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'regime_backtest_trade'
  AND column_name IN ('rank', 'rank_field', 'rank_value')
ORDER BY column_name;
"@
if ($LASTEXITCODE -ne 0) {
  throw "psql verify failed"
}

$found = @($columns | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
Write-Host "  found columns: $($found -join ', ')"
$expected = @('rank', 'rank_field', 'rank_value')
foreach ($col in $expected) {
  if ($found -notcontains $col) {
    throw "Expected column missing: $col"
  }
}

Write-Host ""
Write-Host "==== Migration complete ===="
