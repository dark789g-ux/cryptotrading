# =====================================================================
# 20260602_concept_amv_daily.ps1
#
# AMV 概念板块扶正（方案 B 双表）：
#   建 concept_amv_daily + 搬迁 industry_amv_daily 的 type='N' 行 + 删除 industry 表 type='N'。
#
# spec docs/superpowers/specs/2026-06-02-amv-oneclick-concept-firstclass-design/03-migration.md
#
# 校验不硬编码行数：迁移前即时查 N 行数与 industry 总数，执行后用守恒关系断言
#   (a) concept_rows  == 迁移前 N 行数
#   (b) leftover_n     == 0
#   (c) industry_rows  == 迁移前 industry 总数 - N 行数
#   (d) concept 表 signal IS NULL 计数 == 0
# 任一不达期望即非零退出。
#
# 用法：在仓库根执行
#   powershell apps/server/src/migration/20260602_concept_amv_daily.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260602_concept_amv_daily.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL 文件不存在：$scriptPath"
}

# 在容器里跑一条 SQL 并以 tuples-only/unaligned 取回纯标量（int），失败即抛
function Invoke-Scalar([string]$sql) {
  $out = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c $sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql 查询失败（退出码 $LASTEXITCODE）：$sql"
  }
  return [int](($out | Select-Object -First 1).Trim())
}

# ---- 迁移前基线（即时查，不硬编码）----
Write-Host "==== 迁移前基线（即时查真 DB，不硬编码）===="
$baselineN = Invoke-Scalar @"
SELECT count(*) FROM industry_amv_daily a
JOIN ths_index_catalog c ON c.ts_code = a.ts_code
WHERE c.type = 'N';
"@
$baselineTotal = Invoke-Scalar "SELECT count(*) FROM industry_amv_daily;"
$expectedIndustryAfter = $baselineTotal - $baselineN
Write-Host "  迁移前 industry 总行数      = $baselineTotal"
Write-Host "  迁移前 type='N' 行数 (期望搬迁数) = $baselineN"
Write-Host "  迁移后 industry 期望余量 (I)     = $expectedIndustryAfter"

if ($baselineN -le 0) {
  throw "守恒前提不成立：迁移前 type='N' 行数为 $baselineN（join 未命中或库为空），中止以免误判完整。"
}

# ---- 执行迁移 ----
Write-Host ""
Write-Host "==== 执行 concept_amv_daily 建表 + 搬迁 migration ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql 执行失败，退出码 $LASTEXITCODE"
}

# ---- (a)~(d) 行数对齐 / 守恒校验 ----
Write-Host ""
Write-Host "==== 校验 (a)~(d) ===="

# (a) concept 表行数 == 迁移前 N 行数
$conceptRows = Invoke-Scalar "SELECT count(*) FROM concept_amv_daily;"
Write-Host "  (a) concept_rows = $conceptRows (期望 $baselineN)"

# (b) industry 表不再含任何 type='N'
$leftoverN = Invoke-Scalar @"
SELECT count(*) FROM industry_amv_daily a
JOIN ths_index_catalog c ON c.ts_code = a.ts_code
WHERE c.type = 'N';
"@
Write-Host "  (b) leftover_n   = $leftoverN (期望 0)"

# (c) industry 表余量 == 迁移前 industry 总数 - N 行数（守恒）
$industryRows = Invoke-Scalar "SELECT count(*) FROM industry_amv_daily;"
Write-Host "  (c) industry_rows = $industryRows (期望 $expectedIndustryAfter)"

# (d) concept 表 signal 不得为 NULL（行级硬约束）
$badSignal = Invoke-Scalar "SELECT count(*) FROM concept_amv_daily WHERE signal IS NULL;"
Write-Host "  (d) bad_signal   = $badSignal (期望 0)"

# ---- 断言 ----
$failed = $false
if ($conceptRows -ne $baselineN)            { Write-Host "[FAIL] (a) concept_rows($conceptRows) != 迁移前 N($baselineN)"; $failed = $true }
if ($leftoverN -ne 0)                       { Write-Host "[FAIL] (b) industry 仍残留 type='N' 行：$leftoverN"; $failed = $true }
if ($industryRows -ne $expectedIndustryAfter) { Write-Host "[FAIL] (c) industry_rows($industryRows) != 期望余量($expectedIndustryAfter)"; $failed = $true }
if ($badSignal -ne 0)                       { Write-Host "[FAIL] (d) concept 表存在 signal IS NULL：$badSignal"; $failed = $true }

# 守恒终检：迁移前 industry 总数 == 校验后 industry_rows + concept_rows
if (($industryRows + $conceptRows) -ne $baselineTotal) {
  Write-Host "[FAIL] 守恒破坏：迁移后 industry($industryRows) + concept($conceptRows) = $($industryRows + $conceptRows) != 迁移前总数($baselineTotal)"
  $failed = $true
}

Write-Host ""
if ($failed) {
  throw "concept_amv_daily 迁移校验未通过，请勿当作已完成。"
}
Write-Host "==== 全部校验通过：concept_amv_daily 已建表并搬迁 $conceptRows 行，industry 余 $industryRows 行（守恒成立）===="
