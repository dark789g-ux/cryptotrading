# =====================================================================
# 20260623000001-add-pe-pb-to-index-daily-quotes.ps1
#
# index_daily_quotes 增加 pe / pb 估值列（申万行业指数接入 SW-T1）
# spec: docs/superpowers/specs/2026-06-23-sw-index-integration-design/01-data-model.md
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260623000001-add-pe-pb-to-index-daily-quotes.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

# PowerShell 5.1 管道传给 native command（docker）默认 ASCII，中文会丢字节。
# 本 SQL 无中文，但保持与其它 migration 一致的编码处理，便于后续追加校验 SQL。
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260623000001-add-pe-pb-to-index-daily-quotes.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 index_daily_quotes 增加 pe / pb 列..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：index_daily_quotes 列结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='index_daily_quotes' AND column_name IN ('pe','pb') ORDER BY column_name;"
