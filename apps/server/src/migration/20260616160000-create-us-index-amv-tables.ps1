# =====================================================================
# 20260616160000-create-us-index-amv-tables.ps1
#
# 美股指数活跃市值（AMV）：建 raw.us_index_amv_daily / us_index_constituent
#
# 用法：在仓库根执行
#   powershell apps/server/migrations/20260616160000-create-us-index-amv-tables.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260616160000-create-us-index-amv-tables.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 us-index-amv 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：两张表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_schema='raw' AND table_name IN ('us_index_amv_daily','us_index_constituent') ORDER BY table_name;"

Write-Host ""
Write-Host "==== 校验：建表后行数 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT count(*) AS us_index_amv_daily_rows FROM raw.us_index_amv_daily;"
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT count(*) AS us_index_constituent_rows FROM raw.us_index_constituent;"

Write-Host ""
Write-Host "==== 校验：索引与唯一/CHECK 约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE schemaname='raw' AND tablename IN ('us_index_amv_daily','us_index_constituent') ORDER BY tablename, indexname;"
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='raw.us_index_amv_daily'::regclass ORDER BY conname;"
