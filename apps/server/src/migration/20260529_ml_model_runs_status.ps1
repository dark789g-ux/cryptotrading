# =====================================================================
# 20260529_ml_model_runs_status.ps1
#
# spec 2026-05-29 P2.1：ml.model_runs 加 status TEXT 列（prod/shadow/archived）。
#
# 用法：在仓库根执行 `powershell apps/server/src/migration/20260529_ml_model_runs_status.ps1`
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260529_ml_model_runs_status.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 ml.model_runs.status migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：ml.model_runs.status 列存在 + 约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'ml' AND table_name = 'model_runs' AND column_name = 'status';"

Write-Host ""
Write-Host "==== 校验：现有 model_runs 的 status 分布 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT status, count(*) FROM ml.model_runs GROUP BY status ORDER BY status;"

Write-Host ""
Write-Host "==== 校验：prod 模型详情（如已升级） ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT model_version, status, created_at FROM ml.model_runs WHERE status='prod' ORDER BY created_at DESC LIMIT 5;"
