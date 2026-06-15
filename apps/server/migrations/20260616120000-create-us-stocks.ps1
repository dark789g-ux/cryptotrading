# =====================================================================
# 20260616120000-create-us-stocks.ps1
#
# 美股 Tab：建 raw.us_symbol / us_daily_quote / us_adj_factor / us_daily_indicator
#
# 用法：在仓库根执行
#   powershell apps/server/migrations/20260616120000-create-us-stocks.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260616120000-create-us-stocks.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 us-stocks 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：四张表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_schema='raw' AND table_name IN ('us_symbol','us_daily_quote','us_adj_factor','us_daily_indicator') ORDER BY table_name;"

Write-Host ""
Write-Host "==== 校验：索引与唯一约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE schemaname='raw' AND tablename LIKE 'us_%' ORDER BY tablename, indexname;"
