$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260620150000-backfill-roc-indicators.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
