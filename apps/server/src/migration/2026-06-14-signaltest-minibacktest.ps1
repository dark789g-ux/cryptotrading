# =====================================================================
# 2026-06-14-signaltest-minibacktest.ps1
#
# signal_test 迷你回测升级 schema 地基（spec 03 §3.5）：
#   1. signal_test 加 backtest_config jsonb
#   2. signal_test_run 加 11 个回测指标列
#   3. 新建 signal_test_equity 表 + 唯一约束 + 索引
#
# Usage (from repo root):
#   powershell apps/server/src/migration/2026-06-14-signaltest-minibacktest.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "2026-06-14-signaltest-minibacktest.sql"

if (-not (Test-Path $scriptPath)) {
  throw "SQL file not found: $scriptPath"
}

# Run a SQL query and return a scalar integer result
function Invoke-Scalar([string]$sql) {
  $out = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -tA -c $sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql query failed (exit $LASTEXITCODE): $sql"
  }
  return [int](($out | Select-Object -First 1).Trim())
}

# ---- Execute migration ----
Write-Host "==== Running migration: 2026-06-14-signaltest-minibacktest ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify ----
Write-Host ""
Write-Host "==== Verifying migration results ===="

# 1. signal_test.backtest_config jsonb
$cfgCount = Invoke-Scalar "SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test' AND column_name='backtest_config' AND data_type='jsonb';"
Write-Host "  signal_test.backtest_config (jsonb) exists: $cfgCount (expect 1)"

# 2. signal_test_run 11 个回测指标列
$runColsSql = "SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test_run' AND column_name IN ('final_nav','total_ret','annual_ret','max_drawdown','sharpe','calmar','daily_win_rate','daily_kelly','n_taken','n_skipped','total_costs');"
$runColCount = Invoke-Scalar $runColsSql
Write-Host "  signal_test_run backtest metric columns: $runColCount (expect 11)"

# 3. signal_test_equity 表 + 唯一约束 + 索引
$equityCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name='signal_test_equity' AND table_schema='public';"
Write-Host "  signal_test_equity table exists: $equityCount (expect 1)"

$uqCount = Invoke-Scalar "SELECT count(*) FROM pg_constraint WHERE conname='uq_signal_test_equity_run_date';"
Write-Host "  uq_signal_test_equity_run_date constraint exists: $uqCount (expect 1)"

$idxCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname='idx_signal_test_equity_run';"
Write-Host "  idx_signal_test_equity_run index exists: $idxCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($cfgCount -ne 1)    { Write-Host "[FAIL] signal_test.backtest_config (jsonb) not found"; $failed = $true }
if ($runColCount -ne 11) { Write-Host "[FAIL] signal_test_run backtest metric columns incomplete (got $runColCount, expect 11)"; $failed = $true }
if ($equityCount -ne 1) { Write-Host "[FAIL] signal_test_equity table not found"; $failed = $true }
if ($uqCount -ne 1)     { Write-Host "[FAIL] uq_signal_test_equity_run_date constraint not found"; $failed = $true }
if ($idxCount -ne 1)    { Write-Host "[FAIL] idx_signal_test_equity_run index not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: backtest_config + 11 run metrics + signal_test_equity table ===="
