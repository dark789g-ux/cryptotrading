# =====================================================================
# 20260601120000-create-active-mv.ps1
#
# 活跃市值（AMV）阶段 1：建 stock_amv_daily / industry_amv_daily 两张宽表。
#
# 用法：在仓库根执行
#   powershell apps/server/migrations/20260601120000-create-active-mv.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260601120000-create-active-mv.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 active-mv 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：两张表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_name IN ('stock_amv_daily','industry_amv_daily') ORDER BY table_name;"

Write-Host ""
Write-Host "==== 校验：索引与约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE tablename IN ('stock_amv_daily','industry_amv_daily') ORDER BY tablename, indexname;"
