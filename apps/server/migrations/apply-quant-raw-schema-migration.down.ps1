$ErrorActionPreference = 'Stop'
# 反向（回滚）迁移：把 raw.<table> 搬回 public.a_share_<table>
# 执行后必须同步 git checkout quant-migration-base 并重新部署 NestJS，
# 否则新版 entity 找不到 raw.* 会立即 500（详见 01-pg-schema.md §6）
$sqlPath = Join-Path $PSScriptRoot '20260517120000-quant-raw-schema-migration.down.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
