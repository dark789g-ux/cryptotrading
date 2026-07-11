# =====================================================================
# 20260710_regime_backtest_version_nullable.ps1
#
# Make regime_backtest_run.regime_config_version nullable so create can
# omit regimeConfigId (inline config snapshot only).
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260710_regime_backtest_version_nullable.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260710_regime_backtest_version_nullable.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

Write-Host "==== Running migration: 20260710_regime_backtest_version_nullable ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== Verifying column nullability ===="
$nullable = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c @"
SELECT is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'regime_backtest_run'
  AND column_name = 'regime_config_version';
"@
if ($LASTEXITCODE -ne 0) {
  throw "psql verify failed"
}
$nullable = ($nullable | Select-Object -First 1).Trim()
Write-Host "  regime_config_version is_nullable: $nullable (expect YES)"
if ($nullable -ne "YES") {
  throw "Expected is_nullable=YES, got: $nullable"
}

Write-Host ""
Write-Host "==== Migration complete ===="
