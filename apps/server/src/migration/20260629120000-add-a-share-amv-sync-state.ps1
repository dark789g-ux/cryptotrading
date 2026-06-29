# =====================================================================
# 20260629120000-add-a-share-amv-sync-state.ps1
#
# a_share_sync_states 增加 amv_dirty_from_date / amv_calculated_to_date
# （个股 AMV 增量 dirty 续算 ③-a，镜像 indicator_dirty_from_date / indicator_calculated_to_date）
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260629120000-add-a-share-amv-sync-state.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

# PowerShell 5.1 管道传给 native command（docker）默认 ASCII；保持 UTF8 一致处理。
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260629120000-add-a-share-amv-sync-state.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 a_share_sync_states 增加 amv_dirty_from_date / amv_calculated_to_date 列..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：a_share_sync_states AMV 列 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='a_share_sync_states' AND column_name IN ('amv_dirty_from_date','amv_calculated_to_date') ORDER BY column_name;"
