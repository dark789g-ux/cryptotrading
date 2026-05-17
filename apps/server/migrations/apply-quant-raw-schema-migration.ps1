$ErrorActionPreference = 'Stop'
# 正向迁移：把 5 张 a_share_* 表搬到 raw schema，并去掉 a_share_ 前缀
# 执行前请确认：
#   1. 已停掉所有 A 股同步定时任务（避免脚本执行期间 NestJS 写老表名）
#   2. 已打 git tag quant-migration-base 指向迁移前 commit
#   3. 准备紧随其后部署 NestJS 新版（entity 已切到 raw.*）
$sqlPath = Join-Path $PSScriptRoot '20260517120000-quant-raw-schema-migration.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
