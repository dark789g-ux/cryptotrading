# =====================================================================
# 20260610_oamv_daily_macd.ps1
#
# Add amv_dif/amv_dea/amv_macd columns to oamv_daily (market-level 0AMV MACD).
#
# Usage (from repo root):
#   powershell apps/server/migrations/20260610_oamv_daily_macd.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260610_oamv_daily_macd.sql"

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
Write-Host "==== Running migration: 20260610_oamv_daily_macd ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$colCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='oamv_daily' AND column_name IN ('amv_dif','amv_dea','amv_macd');"
Write-Host "  amv_dif/amv_dea/amv_macd columns exist: $colCount (expect 3)"

# ---- Assertions ----
$failed = $false
if ($colCount -ne 3) { Write-Host "[FAIL] expected 3 columns, got $colCount"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed ===="
