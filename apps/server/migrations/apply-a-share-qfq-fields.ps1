$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260426210000-add-a-share-qfq-fields.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
