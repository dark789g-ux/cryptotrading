-- 20260717120000 添加中证全指 000985.CSI 到大盘指数目录
-- regime 引擎大盘择时 match 条件需要 000985.CSI 的 MACD 指标做三态判定
-- 添加后由 MarketIndexSyncService 自动拉日线 + 计算指标
-- 注意：Tushare 中中证指数公司发布的指数后缀为 CSI（非 SH），
--   000001.SH 是上交所发布所以用 SH，000985 是中证指数公司发布所以用 CSI
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260717120000-add-csi-all-index.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

BEGIN;

-- 添加中证全指 000985.CSI 到大盘指数目录
INSERT INTO ths_index_catalog (ts_code, name, type, exchange)
VALUES ('000985.CSI', '中证全指', 'M', 'SH')
ON CONFLICT (ts_code) DO NOTHING;

COMMIT;
