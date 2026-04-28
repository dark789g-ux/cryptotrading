$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "20260428170000-auth-workspace-phase1.sql"
Get-Content -Raw -Encoding utf8 $scriptPath |
  docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
