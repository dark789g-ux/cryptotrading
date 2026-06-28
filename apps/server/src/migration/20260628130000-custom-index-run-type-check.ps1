# =====================================================================
# 20260628130000-custom-index-run-type-check.ps1
#
# ml_jobs_run_type_check 加入 'custom_index_compute'
# spec: docs/superpowers/specs/2026-06-28-custom-index-create-design/02-data-model.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260628130000-custom-index-run-type-check.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260628130000-custom-index-run-type-check.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 ml_jobs_run_type_check 加入 custom_index_compute migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：约束现含 custom_index_compute ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='ml_jobs_run_type_check';"
