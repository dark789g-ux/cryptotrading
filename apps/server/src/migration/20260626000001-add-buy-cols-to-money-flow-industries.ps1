# =====================================================================
# 20260626000001-add-buy-cols-to-money-flow-industries.ps1
#
# 为 money_flow_industries 表新增大/中/小单净流入列（申万行业资金流补齐）
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260626000001-add-buy-cols-to-money-flow-industries.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260626000001-add-buy-cols-to-money-flow-industries.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 money_flow_industries 加列 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：列已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'money_flow_industries' AND column_name IN ('buy_lg_amount','buy_md_amount','buy_sm_amount');"
