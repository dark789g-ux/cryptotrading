$sqlFiles = @(
  '20260426170000-create-a-share-daily-indicators.sql',
  '20260426183000-add-a-share-brick-indicators.sql',
  '20260428110000-add-a-share-incremental-sync-state.sql'
)

foreach ($sqlFile in $sqlFiles) {
  $sqlPath = Join-Path $PSScriptRoot $sqlFile
  Get-Content -Path $sqlPath -Encoding utf8 | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
}
