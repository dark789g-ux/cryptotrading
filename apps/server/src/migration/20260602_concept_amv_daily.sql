-- =====================================================================
-- 20260602_concept_amv_daily.sql
--
-- AMV 概念板块扶正（方案 B 双表）：
--   ① 建 concept_amv_daily（列/约束/索引 = industry_amv_daily）
--   ② 把 industry_amv_daily 中 type='N'（同花顺概念/题材板块）的行搬进 concept_amv_daily
--   ③ 从 industry_amv_daily 删除 type='N' 的行（industry 表收紧为只存 type='I'）
--
-- spec docs/superpowers/specs/2026-06-02-amv-oneclick-concept-firstclass-design/
--      02-backend-concept-firstclass.md / 03-migration.md
--
-- 「type='N'」一律通过 JOIN ths_index_catalog c ON c.ts_code = a.ts_code WHERE c.type='N'
-- 判定，不得用 ts_code 字符串规律硬猜（真 DB 已核：ths_index_catalog 有 ts_code/type 列，
-- N=409 个指数，join industry_amv_daily 命中 24466 行）。
--
-- 全幂等：建表 IF NOT EXISTS、搬迁 ON CONFLICT DO NOTHING、删除按 join 条件（重入安全）。
-- 行数对齐校验见同名 .ps1（(a)~(d)），用守恒关系而非硬编码行数。
-- =====================================================================

-- ① 建表（列/约束/索引名 = industry_amv_daily，只把 industry 换成 concept）
CREATE TABLE IF NOT EXISTS concept_amv_daily (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  amv_open double precision,
  amv_high double precision,
  amv_low double precision,
  amv_close double precision,
  amv_dif double precision,
  amv_dea double precision,
  amv_macd double precision,
  amv_zdf double precision,
  signal smallint NOT NULL,
  member_count integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_concept_amv_daily_code_date UNIQUE (ts_code, trade_date),
  CONSTRAINT ck_concept_amv_daily_signal CHECK (signal IN (-1, 0, 1))
);

CREATE INDEX IF NOT EXISTS idx_concept_amv_daily_code_date
  ON concept_amv_daily (ts_code, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_concept_amv_daily_date_signal
  ON concept_amv_daily (trade_date, signal);

-- ② 搬迁 type='N'（ON CONFLICT 保证重入不重复）
INSERT INTO concept_amv_daily
  (ts_code, trade_date, amv_open, amv_high, amv_low, amv_close,
   amv_dif, amv_dea, amv_macd, amv_zdf, signal, member_count, updated_at)
SELECT a.ts_code, a.trade_date, a.amv_open, a.amv_high, a.amv_low, a.amv_close,
       a.amv_dif, a.amv_dea, a.amv_macd, a.amv_zdf, a.signal, a.member_count, a.updated_at
FROM industry_amv_daily a
JOIN ths_index_catalog c ON c.ts_code = a.ts_code
WHERE c.type = 'N'
ON CONFLICT (ts_code, trade_date) DO NOTHING;

-- ③ 从 industry 表删除 type='N'
DELETE FROM industry_amv_daily a
USING ths_index_catalog c
WHERE c.ts_code = a.ts_code AND c.type = 'N';
