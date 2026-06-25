# =====================================================================
# 20260625000004-create-money-flow-ths-industries.ps1
#
# 新建 money_flow_ths_industries 表：同花顺行业资金流向
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260625000004-create-money-flow-ths-industries.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260625000004-create-money-flow-ths-industries.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 money_flow_ths_industries 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_name = 'money_flow_ths_industries';"

Write-Host ""
Write-Host "==== 校验：索引与约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE tablename = 'money_flow_ths_industries' ORDER BY indexname;"
