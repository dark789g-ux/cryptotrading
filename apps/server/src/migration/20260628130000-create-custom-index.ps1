# =====================================================================
# 20260628130000-create-custom-index.ps1
#
# 新建 custom_index_* 自定义指数表族
# spec: docs/superpowers/specs/2026-06-28-custom-index-create-design/02-data-model.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260628130000-create-custom-index.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260628130000-create-custom-index.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 custom_index_* 建表..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：custom_index 表列表 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'custom_index_%' ORDER BY table_name;"

Write-Host ""
Write-Host "==== 校验：custom_index_definitions 列结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='custom_index_definitions' ORDER BY ordinal_position;"
