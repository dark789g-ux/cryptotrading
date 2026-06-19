# =====================================================================
# 20260616130000-create-us-index.ps1
#
# 美股指数二级 Tab：建 raw.us_index_daily / us_index_indicator
#
# 用法：在仓库根执行
#   powershell apps/server/migrations/20260616130000-create-us-index.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260616130000-create-us-index.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 us-index 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：两张表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_schema='raw' AND table_name IN ('us_index_daily','us_index_indicator') ORDER BY table_name;"

Write-Host ""
Write-Host "==== 校验：建表后行数 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT count(*) AS us_index_daily_rows FROM raw.us_index_daily;"
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT count(*) AS us_index_indicator_rows FROM raw.us_index_indicator;"

Write-Host ""
Write-Host "==== 校验：索引与唯一约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE schemaname='raw' AND tablename IN ('us_index_daily','us_index_indicator') ORDER BY tablename, indexname;"
