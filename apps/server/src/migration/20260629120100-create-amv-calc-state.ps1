# =====================================================================
# 20260629120100-create-amv-calc-state.ps1
#
# 创建 raw.amv_calc_state（个股 AMV streaming 递推状态 checkpoint，③-a）
# 镜像 raw.indicator_calc_state。用法：在仓库根执行
#   powershell apps/server/src/migration/20260629120100-create-amv-calc-state.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260629120100-create-amv-calc-state.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行创建 raw.amv_calc_state..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：raw.amv_calc_state 表结构 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='raw' AND table_name='amv_calc_state' ORDER BY ordinal_position;"

Write-Host "==== 校验：唯一约束 + 索引 ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='raw' AND tablename='amv_calc_state' ORDER BY indexname;"
