$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260428171000-auth-workspace-finalize.sql"
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
