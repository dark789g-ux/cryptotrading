# =====================================================================
# 20260625000001-drop-a-share-industry-add-sw-fields.ps1
#
# a_share_symbols 删除旧 industry 列，新增申万三级行业字段
# spec: docs/superpowers/specs/2026-06-23-sw-index-integration-design/01-data-model.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260625000001-drop-a-share-industry-add-sw-fields.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260625000001-drop-a-share-industry-add-sw-fields.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 a_share_symbols 字段改造..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：a_share_symbols 列结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='a_share_symbols' ORDER BY ordinal_position;"

Write-Host ""
Write-Host "==== 校验：索引 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='a_share_symbols' ORDER BY indexname;"
