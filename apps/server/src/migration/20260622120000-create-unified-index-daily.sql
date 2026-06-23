-- 20260622120000 统一 A 股指数日线表（迁移 ths_index_daily_* + 新增 category 支持大盘）
-- spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260622120000-create-unified-index-daily.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -

BEGIN;

-- 步骤 1：给 ths_index_catalog 灌入大盘 8 个（type='M'，INSERT...WHERE NOT EXISTS 防重）
-- 大盘代码不在 Tushare ths_index 接口，初始 8 个宽基作动态范围种子数据（后续由管理页面维护）
INSERT INTO ths_index_catalog (ts_code, name, type, exchange)
SELECT v.ts_code, v.name, v.type, v.exchange
FROM (VALUES
  ('000001.SH'::varchar, '上证指数',  'M'::varchar, 'A'::varchar),
  ('399001.SZ'::varchar, '深证成指',  'M',          'A'),
  ('399006.SZ'::varchar, '创业板指',  'M',          'A'),
  ('000688.SH'::varchar, '科创50',    'M',          'A'),
  ('000300.SH'::varchar, '沪深300',   'M',          'A'),
  ('000016.SH'::varchar, '上证50',    'M',          'A'),
  ('000905.SH'::varchar, '中证500',   'M',          'A'),
  ('000852.SH'::varchar, '中证1000',  'M',          'A')
) AS v(ts_code, name, type, exchange)
WHERE NOT EXISTS (SELECT 1 FROM ths_index_catalog c WHERE c.ts_code = v.ts_code);

-- 步骤 2：建 index_daily_quotes（ths 字段 + amount + category）
CREATE TABLE IF NOT EXISTS index_daily_quotes (
  id              BIGSERIAL PRIMARY KEY,
  ts_code         VARCHAR(20)      NOT NULL,
  trade_date      VARCHAR(8)       NOT NULL,
  open            DOUBLE PRECISION,
  high            DOUBLE PRECISION,
  low             DOUBLE PRECISION,
  close           DOUBLE PRECISION,
  pre_close       DOUBLE PRECISION,
  change          DOUBLE PRECISION,
  pct_change      DOUBLE PRECISION,
  vol_hand        DOUBLE PRECISION,
  amount          DOUBLE PRECISION,
  total_mv_wan    NUMERIC(20, 4),
  float_mv_wan    NUMERIC(20, 4),
  turnover_rate   DOUBLE PRECISION,
  category        VARCHAR(8)       NOT NULL,
  updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_index_daily_quotes UNIQUE (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_index_daily_quotes_category_tradedate
  ON index_daily_quotes (category, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_index_daily_quotes_tscode_tradedate
  ON index_daily_quotes (ts_code, trade_date DESC);

-- 步骤 3：迁移 quotes（category 统一走 catalog.type，判据单一真源）
INSERT INTO index_daily_quotes (
  ts_code, trade_date, open, high, low, close, pre_close, change, pct_change,
  vol_hand, total_mv_wan, float_mv_wan, turnover_rate, category, updated_at
)
SELECT
  q.ts_code, q.trade_date, q.open, q.high, q.low, q.close, q.pre_close, q.change, q.pct_change,
  q.vol_hand, q.total_mv_wan, q.float_mv_wan, q.turnover_rate,
  CASE c.type
    WHEN 'I' THEN 'industry'::varchar
    WHEN 'N' THEN 'concept'
    WHEN 'M' THEN 'market'
  END,
  q.updated_at
FROM ths_index_daily_quotes q
INNER JOIN ths_index_catalog c ON c.ts_code = q.ts_code
WHERE c.type IN ('I', 'N', 'M');
-- INNER JOIN + WHERE type IN 限定：只迁 catalog 命中的行，category 必非 NULL（满足 NOT NULL）

-- 步骤 4：建 index_daily_indicators
CREATE TABLE IF NOT EXISTS index_daily_indicators (
  id              BIGSERIAL PRIMARY KEY,
  ts_code         VARCHAR(20)      NOT NULL,
  trade_date      VARCHAR(8)       NOT NULL,
  ma5             DOUBLE PRECISION,
  ma30            DOUBLE PRECISION,
  ma60            DOUBLE PRECISION,
  ma120           DOUBLE PRECISION,
  ma240           DOUBLE PRECISION,
  dif             DOUBLE PRECISION,
  dea             DOUBLE PRECISION,
  macd            DOUBLE PRECISION,
  kdj_k           DOUBLE PRECISION,
  kdj_d           DOUBLE PRECISION,
  kdj_j           DOUBLE PRECISION,
  bbi             DOUBLE PRECISION,
  brick           DOUBLE PRECISION,
  brick_delta     DOUBLE PRECISION,
  brick_xg        BOOLEAN,
  category        VARCHAR(8)       NOT NULL,
  updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_index_daily_indicators UNIQUE (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_index_daily_indicators_category_tradedate
  ON index_daily_indicators (category, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_index_daily_indicators_tscode_tradedate
  ON index_daily_indicators (ts_code, trade_date DESC);

-- 步骤 5：迁移 indicators（category 取同 ts_code+trade_date 的 quote.category）
INSERT INTO index_daily_indicators (
  ts_code, trade_date, ma5, ma30, ma60, ma120, ma240, dif, dea, macd,
  kdj_k, kdj_d, kdj_j, bbi, brick, brick_delta, brick_xg, category, updated_at
)
SELECT
  i.ts_code, i.trade_date, i.ma5, i.ma30, i.ma60, i.ma120, i.ma240,
  i.dif, i.dea, i.macd, i.kdj_k, i.kdj_d, i.kdj_j, i.bbi,
  i.brick, i.brick_delta, i.brick_xg, dq.category, i.updated_at
FROM ths_index_daily_indicators i
INNER JOIN index_daily_quotes dq
  ON dq.ts_code = i.ts_code AND dq.trade_date = i.trade_date;
-- INNER JOIN 保证 category 非 NULL（indicator 行必有对应已迁 quote）

-- 步骤 6：旧表 RENAME 备份（不 DROP，验证无误后另行清理）
ALTER TABLE ths_index_daily_quotes RENAME TO ths_index_daily_quotes_legacy;
ALTER TABLE ths_index_daily_indicators RENAME TO ths_index_daily_indicators_legacy;
-- 注：旧表的索引/约束（idx_ths_*、uq_ths_*）随表改名，不与新表索引冲突

COMMIT;
