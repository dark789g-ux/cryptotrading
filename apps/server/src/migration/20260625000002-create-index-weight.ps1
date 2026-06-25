# =====================================================================
# 20260625000002-create-index-weight.ps1
#
# 新建 index_weight 指数成分股权重版本链表
# spec: docs/superpowers/specs/2026-06-25-index-weight-version-list/02-data-model.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260625000002-create-index-weight.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

# PowerShell 5.1 管道传给 native command（docker）默认 ASCII，保持 UTF-8 以兼容后续可能的中文校验 SQL。
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260625000002-create-index-weight.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 index_weight 建表..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：index_weight 列结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='index_weight' ORDER BY ordinal_position;"

Write-Host ""
Write-Host "==== 校验：索引 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='index_weight' ORDER BY indexname;"
