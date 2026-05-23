# =====================================================================
# 20260524_ml_jobs_warnings.ps1
#
# PIT 窗口护门 Migration B（spec 2026-05-23-pit-window-guard-design §06.1）：
#   - 给 ml.jobs 增加 warnings JSONB 列（默认 '[]'）
#
# CLAUDE.md 硬约束：DB schema 调整须附 docker exec 形式的 .ps1 + .sql 配对
# 用法：在仓库根执行 `pwsh apps/server/migrations/20260524_ml_jobs_warnings.ps1`
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260524_ml_jobs_warnings.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 ml.jobs.warnings migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：ml.jobs.warnings 列存在 + 默认值 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'ml' AND table_name = 'jobs' AND column_name = 'warnings';"
