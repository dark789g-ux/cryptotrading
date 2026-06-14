# =====================================================================
# 2026-06-14-portfolio-sim-fill-factor-values.ps1
#
# Add factor_values (jsonb) and rank_score (numeric) columns to
# portfolio_sim_fill (per-factor transparency, spec 08-persistence).
#
# Usage (from repo root):
#   powershell apps/server/migrations/2026-06-14-portfolio-sim-fill-factor-values.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "2026-06-14-portfolio-sim-fill-factor-values.sql"

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
Write-Host "==== Running migration: 2026-06-14-portfolio-sim-fill-factor-values ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$factorValuesCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='portfolio_sim_fill' AND column_name='factor_values';"
Write-Host "  factor_values column exists: $factorValuesCount (expect 1)"

$factorValuesJsonb = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='portfolio_sim_fill' AND column_name='factor_values' AND data_type='jsonb';"
Write-Host "  factor_values is jsonb: $factorValuesJsonb (expect 1)"

$rankScoreCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='portfolio_sim_fill' AND column_name='rank_score';"
Write-Host "  rank_score column exists: $rankScoreCount (expect 1)"

$rankScoreNumeric = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='portfolio_sim_fill' AND column_name='rank_score' AND data_type='numeric';"
Write-Host "  rank_score is numeric: $rankScoreNumeric (expect 1)"

# ---- Assertions ----
$failed = $false
if ($factorValuesCount -ne 1)  { Write-Host "[FAIL] factor_values column not found"; $failed = $true }
if ($factorValuesJsonb -ne 1)  { Write-Host "[FAIL] factor_values is not jsonb"; $failed = $true }
if ($rankScoreCount -ne 1)     { Write-Host "[FAIL] rank_score column not found"; $failed = $true }
if ($rankScoreNumeric -ne 1)   { Write-Host "[FAIL] rank_score is not numeric"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: portfolio_sim_fill.factor_values + rank_score added ===="
