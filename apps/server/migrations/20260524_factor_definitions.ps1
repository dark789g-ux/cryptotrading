# =====================================================================
# 20260524_factor_definitions.ps1
#
# NestJS 侧幂等校验脚本（spec 2026-05-23-factor-registry-frontend-design）：
#   - 正常路径下因子元数据表已由 quant-pipeline Alembic 建好
#   - 本脚本仅用于发布记录 / 灾难恢复 / CI schema 漂移检测，不重复 DDL
#   - 用法：在仓库根执行 `pwsh apps/server/migrations/20260524_factor_definitions.ps1`
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260524_factor_definitions.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 factor_definitions 幂等校验脚本..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -

Write-Host ""
Write-Host "==== 表结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.factor_definitions"

Write-Host ""
Write-Host "==== 当前 v1 行数（期望与当前 registry 因子数一致） ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT factor_version, COUNT(*) FROM factors.factor_definitions GROUP BY factor_version ORDER BY factor_version;"

Write-Host ""
Write-Host "==== 启用因子（display_order 排序） ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT factor_id, category, pit_window_days, pit_anchor, enabled, display_order FROM factors.factor_definitions WHERE factor_version = 'v1' ORDER BY display_order ASC, factor_id ASC;"
