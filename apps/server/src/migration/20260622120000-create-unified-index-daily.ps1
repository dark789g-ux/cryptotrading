# =====================================================================
# 20260622120000-create-unified-index-daily.ps1
#
# 统一 A 股指数日线表：迁移 ths_index_daily_quotes/indicators → index_daily_*
# + 新增 category（market/industry/concept）+ ths_index_catalog 灌大盘 8 个 type='M'
# spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260622120000-create-unified-index-daily.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

# PowerShell 5.1 管道传给 native command（docker）默认用 ASCII 编码，SQL 里的中文
# （大盘名称「上证指数」等）会被吃成 '?'（落库 octet_length 偏小、ascii=63）。
# 显式设为 UTF-8，确保 Get-Content -Encoding utf8 读出的中文经 docker exec -i 正确进 psql。
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260622120000-create-unified-index-daily.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 unified-index-daily 建表 + 数据迁移..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：新表 + 旧表备份 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('index_daily_quotes','index_daily_indicators','ths_index_daily_quotes_legacy','ths_index_daily_indicators_legacy') ORDER BY table_name;"

Write-Host ""
Write-Host "==== 校验：quotes category 分布 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT category, COUNT(*) AS rows FROM index_daily_quotes GROUP BY category ORDER BY category;"

Write-Host ""
Write-Host "==== 校验：大盘 catalog type='M' ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT ts_code, name FROM ths_index_catalog WHERE type='M' ORDER BY ts_code;"
