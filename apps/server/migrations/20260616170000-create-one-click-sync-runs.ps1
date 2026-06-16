# =====================================================================
# 20260616170000-create-one-click-sync-runs.ps1
#
# 「一键同步」后端托管编排：建持久化任务进度表 one_click_sync_runs。
#
# 用法：在仓库根执行
#   powershell apps/server/migrations/20260616170000-create-one-click-sync-runs.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260616170000-create-one-click-sync-runs.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 one-click-sync-runs 建表 migration..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：表已存在 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT table_name FROM information_schema.tables WHERE table_name = 'one_click_sync_runs';"

Write-Host ""
Write-Host "==== 校验：约束与索引 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT conname FROM pg_constraint WHERE conrelid = 'one_click_sync_runs'::regclass ORDER BY conname;"
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname FROM pg_indexes WHERE tablename = 'one_click_sync_runs' ORDER BY indexname;"
