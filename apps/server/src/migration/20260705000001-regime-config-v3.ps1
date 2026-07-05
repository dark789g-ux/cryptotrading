# =====================================================================
# 20260705000001-regime-config-v3.ps1
#
# Regime 配置 v3：将旧配置（基于 marketIndex 与 idx_ 前缀字段）
# 迁移为分桶条件结构（type / target / field）。
# 同时清空 regime_daily_pick 历史数据（结构与旧象限不兼容）。
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260705000001-regime-config-v3.ps1
# =====================================================================

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260705000001-regime-config-v3.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 Regime 配置 v3 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：regime_strategy_config 数量 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT count(*) AS config_count FROM regime_strategy_config;"
