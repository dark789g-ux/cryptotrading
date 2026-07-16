# =====================================================================
# 20260717_create_api_keys.ps1
#
# 创建 api_keys 表，用于存储用户 API 密钥。
#   包含 user_id 外键、key_hash/key_prefix、过期/吊销时间等字段。
#   建立两个索引: idx_api_keys_user_id, idx_api_keys_key_hash。
#
# Usage (from repo root):
#   powershell apps/server/src/migration/20260717_create_api_keys.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260717_create_api_keys.sql"

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
Write-Host "==== Running migration: 20260717_create_api_keys ===="
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

if ($LASTEXITCODE -ne 0) {
  throw "psql execution failed, exit code $LASTEXITCODE"
}

# ---- Verify table and indexes exist ----
Write-Host ""
Write-Host "==== Verifying tables and indexes ===="

$tableCount = Invoke-Scalar "SELECT count(*) FROM information_schema.tables WHERE table_name = 'api_keys' AND table_schema = 'public';"
Write-Host "  api_keys table exists: $tableCount (expect 1)"

$idxUserIdCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_api_keys_user_id';"
Write-Host "  idx_api_keys_user_id exists: $idxUserIdCount (expect 1)"

$idxKeyHashCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_api_keys_key_hash';"
Write-Host "  idx_api_keys_key_hash exists: $idxKeyHashCount (expect 1)"

$pkIndexCount = Invoke-Scalar "SELECT count(*) FROM pg_indexes WHERE indexname = 'api_keys_pkey';"
Write-Host "  api_keys_pkey exists: $pkIndexCount (expect 1)"

# ---- Assertions ----
$failed = $false
if ($tableCount -ne 1)       { Write-Host "[FAIL] api_keys table not found"; $failed = $true }
if ($idxUserIdCount -ne 1)   { Write-Host "[FAIL] idx_api_keys_user_id not found"; $failed = $true }
if ($idxKeyHashCount -ne 1)  { Write-Host "[FAIL] idx_api_keys_key_hash not found"; $failed = $true }
if ($pkIndexCount -ne 1)     { Write-Host "[FAIL] api_keys_pkey not found"; $failed = $true }

Write-Host ""
if ($failed) {
  throw "Migration verification failed. Please check the output above."
}
Write-Host "==== All verifications passed: api_keys created with 3 indexes ===="
