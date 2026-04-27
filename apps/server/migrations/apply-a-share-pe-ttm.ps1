$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260428143000-add-a-share-pe-ttm.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
