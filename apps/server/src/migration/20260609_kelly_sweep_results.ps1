# =====================================================================
# 20260609_kelly_sweep_results.ps1
#
# ml_jobs_run_type_check 加入 'kelly_sweep' +
# 建 research.kelly_sweep_results 结果表 + 两个索引
#
# 权威执行路径: alembic upgrade head（在 apps/quant-pipeline/ 下执行）
# 本脚本供 NestJS 侧迁移规范对齐与人工核验。
#
# Usage (from repo root):
#   powershell apps/server/migrations/20260609_kelly_sweep_results.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260609_kelly_sweep_results.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

# Run a SQL query and return a scalar result (trimmed string)
function Invoke-Scalar([string]$sql) {
  $out = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c $sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql query failed (exit $LASTEXITCODE): $sql"
  }
  return (($out | Select-Object -First 1).Trim())
}

# ---- Execute migration ----
Write-Host "==== Running migration: 20260609_kelly_sweep_results ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

$constraintDef = Invoke-Scalar "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ml_jobs_run_type_check';"
Write-Host "  ml_jobs_run_type_check: $constraintDef"

$kellyInConstraint = if ($constraintDef -match "kelly_sweep") { 1 } else { 0 }

$schemaCount = Invoke-Scalar "SELECT count(*) FROM information_schema.schemata WHERE schema_name='research';"
Write-Host "  research schema exists: $schemaCount (expect 1)"

$tableCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_schema='research' AND table_name='kelly_sweep_results';"
Write-Host "  kelly_sweep_results table exists: $tableCount (expect 1)"

$colCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema='research' AND table_name='kelly_sweep_results';"
Write-Host "  kelly_sweep_results column count: $colCount (expect 24)"

$idxGroupCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname='idx_ksr_job_group';"
Write-Host "  idx_ksr_job_group exists: $idxGroupCount (expect 1)"

$idxTopkCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname='idx_ksr_job_topk';"
Write-Host "  idx_ksr_job_topk exists: $idxTopkCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($kellyInConstraint -ne 1) { Write-Host "[FAIL] kelly_sweep not in ml_jobs_run_type_check"; $failed = $true }
if ($schemaCount -ne "1")     { Write-Host "[FAIL] research schema not found"; $failed = $true }
if ($tableCount -ne "1")      { Write-Host "[FAIL] kelly_sweep_results table not found"; $failed = $true }
if ($colCount -ne "24")       { Write-Host "[FAIL] kelly_sweep_results column count mismatch (got $colCount, expect 24)"; $failed = $true }
if ($idxGroupCount -ne "1")   { Write-Host "[FAIL] idx_ksr_job_group not found"; $failed = $true }
if ($idxTopkCount -ne "1")    { Write-Host "[FAIL] idx_ksr_job_topk not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: kelly_sweep_results created, CHECK constraint updated ===="
