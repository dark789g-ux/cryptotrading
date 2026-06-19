# =====================================================================
# 20260524_factor_definitions_min_trade_days.ps1
#
# PIT 窗口护门 Migration A（spec 2026-05-23-pit-window-guard-design §02-data-model.md）：
#   - 给 factors.factor_definitions 增加 min_trade_days 列 + 跨字段 CHECK
#   - 回填 16 个现有因子的 min_trade_days
#   - 把 pit_window_days 不足的行抬高到 min_trade_days * 2
#
# CLAUDE.md 硬约束：DB schema 调整须附 docker exec 形式的 .ps1 + .sql 配对
# 用法：在仓库根执行 `pwsh apps/server/src/migration/20260524_factor_definitions_min_trade_days.ps1`
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260524_factor_definitions_min_trade_days.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 factor_definitions min_trade_days migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：pit_window_days < min_trade_days * 2 的行（期望 0） ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT factor_id, factor_version, pit_window_days, min_trade_days FROM factors.factor_definitions WHERE pit_window_days < min_trade_days * 2 OR min_trade_days < 1 OR min_trade_days > 250;"

Write-Host ""
Write-Host "==== 当前 16 因子的 min_trade_days / pit_window_days ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT factor_id, min_trade_days, pit_window_days, pit_window_days >= min_trade_days * 2 AS ok FROM factors.factor_definitions WHERE factor_version = 'v1' ORDER BY category, display_order;"
