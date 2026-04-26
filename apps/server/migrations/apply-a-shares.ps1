$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260426143000-create-a-shares.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
