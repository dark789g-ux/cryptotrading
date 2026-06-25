# =====================================================================
# 20260625000005-alter-money-flow-market.ps1
#
# 为 money_flow_market 表新增 buy_md_amount 列（中单净流入）
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260625000005-alter-money-flow-market.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260625000005-alter-money-flow-market.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 money_flow_market 加列 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：列已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'money_flow_market' AND column_name = 'buy_md_amount';"
