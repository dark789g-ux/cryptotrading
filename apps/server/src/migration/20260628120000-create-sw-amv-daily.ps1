# =====================================================================
# 20260628120000-create-sw-amv-daily.ps1
#
# 申万指数 AMV 宽表 sw_amv_daily。
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260628120000-create-sw-amv-daily.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260628120000-create-sw-amv-daily.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 sw_amv_daily 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：sw_amv_daily 已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_name = 'sw_amv_daily';"
