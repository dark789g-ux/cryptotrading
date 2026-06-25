# =====================================================================
# 20260625000003-create-money-flow-index.ps1
#
# 新建 money_flow_index 表：指数资金流向
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260625000003-create-money-flow-index.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260625000003-create-money-flow-index.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 money_flow_index 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_name = 'money_flow_index';"

Write-Host ""
Write-Host "==== 校验：索引与约束 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE tablename = 'money_flow_index' ORDER BY indexname;"
