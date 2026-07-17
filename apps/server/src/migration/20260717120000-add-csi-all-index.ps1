# =====================================================================
# 20260717120000-add-csi-all-index.ps1
#
# 添加中证全指 000985.CSI 到大盘指数目录（ths_index_catalog）
# regime 引擎大盘择时需要该指数的 MACD 指标做三态判定
# 注意：Tushare ts_code 用 000985.CSI（中证指数公司发布，非 SH）
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260717120000-add-csi-all-index.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptPath = Join-Path $PSScriptRoot "20260717120000-add-csi-all-index.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

Write-Host "执行 add-csi-all-index：插入 000985.CSI 中证全指到大盘目录..."
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== 校验：大盘 catalog type='M'（含新增 000985.CSI） ===="
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -c `
  "SELECT ts_code, name FROM ths_index_catalog WHERE type='M' ORDER BY ts_code;"
