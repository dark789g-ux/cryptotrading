# =====================================================================
# 20260623000002-create-sw-index-catalog.ps1
#
# 新建 sw_index_catalog 申万行业指数目录表（SW-T1）
# spec: docs/superpowers/specs/2026-06-23-sw-index-integration-design/01-data-model.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260623000002-create-sw-index-catalog.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

# PowerShell 5.1 管道传给 native command（docker）默认 ASCII，保持 UTF-8 以兼容后续可能的中文校验 SQL。
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260623000002-create-sw-index-catalog.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 sw_index_catalog 建表..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：sw_index_catalog 列结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='sw_index_catalog' ORDER BY ordinal_position;"

Write-Host ""
Write-Host "==== 校验：索引 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='sw_index_catalog' ORDER BY indexname;"
