# =====================================================================
# 20260705000000-regime-config-v2.ps1
#
# Regime 配置 v2：象限 key 由用户自定义，不再限定 Q1-Q4。
# 扩 regime_daily_pick.regime 列并清空历史 picks。
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260705000000-regime-config-v2.ps1
# =====================================================================

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260705000000-regime-config-v2.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 regime 配置 v2 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：regime_daily_pick 列结构与行数 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name='regime_daily_pick' AND column_name='regime';"

docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT count(*) AS pick_rows FROM regime_daily_pick;"
