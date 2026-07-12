$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260712-add-vwap-indicators.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
