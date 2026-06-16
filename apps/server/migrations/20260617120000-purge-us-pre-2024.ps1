# =====================================================================
# 20260617120000-purge-us-pre-2024.ps1
#
# 美股数据源 AkShare→Yahoo 迁移："先灌后删"收尾——删 6 张表 trade_date < '20240101' 全行。
#
# ⚠️ 执行前提：必须已用 Yahoo 源重灌 2024-01-01 起的数据并校验通过，再跑本脚本（spec §E）。
#
# 用法：在仓库根执行
#   powershell apps/server/migrations/20260617120000-purge-us-pre-2024.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260617120000-purge-us-pre-2024.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "==== 执行前：各表 trade_date < 20240101 残留行数 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT 'us_daily_quote' AS tbl, count(*) FROM raw.us_daily_quote WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_adj_factor', count(*) FROM raw.us_adj_factor WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_daily_indicator', count(*) FROM raw.us_daily_indicator WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_index_daily', count(*) FROM raw.us_index_daily WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_index_indicator', count(*) FROM raw.us_index_indicator WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_index_amv_daily', count(*) FROM raw.us_index_amv_daily WHERE trade_date < '20240101';"

Write-Host ""
Write-Host "执行 pre-2024 清理 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：执行后应全为 0（幂等，可重复执行） ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT 'us_daily_quote' AS tbl, count(*) FROM raw.us_daily_quote WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_adj_factor', count(*) FROM raw.us_adj_factor WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_daily_indicator', count(*) FROM raw.us_daily_indicator WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_index_daily', count(*) FROM raw.us_index_daily WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_index_indicator', count(*) FROM raw.us_index_indicator WHERE trade_date < '20240101'
   UNION ALL SELECT 'us_index_amv_daily', count(*) FROM raw.us_index_amv_daily WHERE trade_date < '20240101';"
