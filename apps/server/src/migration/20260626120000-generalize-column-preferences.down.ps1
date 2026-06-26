$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260626120000-generalize-column-preferences.down.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
