# 03 · 迁移：建表 + 搬迁 type='N' 数据

← 返回 [`./index.md`](./index.md)

按 CLAUDE.md 约定：`apps/server/migrations/*.sql` + 同名 `.ps1`（内置 `docker exec`）。
文件名沿用既有命名风格（实现前先 `ls apps/server/migrations/` 对齐前缀格式），
本设计暂以 `20260602_concept_amv_daily` 指代。

## 迁移步骤（幂等）

```text
① 建 concept_amv_daily（列/约束/索引 = industry_amv_daily，见 02 文档）
② 把 industry_amv_daily 中 type='N' 的行 INSERT 进 concept_amv_daily
③ 从 industry_amv_daily DELETE 掉 type='N' 的行
④ 行数对齐校验
```

「type='N'」一律通过 `JOIN ths_index_catalog c ON c.ts_code = a.ts_code WHERE c.type='N'` 判定，
**不得**用 ts_code 字符串规律硬猜。

## SQL（`20260602_concept_amv_daily.sql`）

```sql
-- ① 建表（IF NOT EXISTS 保证可重入）
CREATE TABLE IF NOT EXISTS concept_amv_daily (
  id            BIGSERIAL PRIMARY KEY,
  ts_code       VARCHAR NOT NULL,
  trade_date    VARCHAR(8) NOT NULL,
  amv_open      DOUBLE PRECISION,
  amv_high      DOUBLE PRECISION,
  amv_low       DOUBLE PRECISION,
  amv_close     DOUBLE PRECISION,
  amv_dif       DOUBLE PRECISION,
  amv_dea       DOUBLE PRECISION,
  amv_macd      DOUBLE PRECISION,
  amv_zdf       DOUBLE PRECISION,
  signal        SMALLINT NOT NULL,
  member_count  INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_concept_amv_daily_code_date UNIQUE (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_concept_amv_daily_code_date
  ON concept_amv_daily (ts_code, trade_date);
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
```

## ④ 行数对齐校验（执行后必跑）

真 DB 基线（迁移前）：industry 表 I=36420 / N=24466。校验断言：

```sql
-- (a) concept 表应等于搬迁前的 N 行数
SELECT COUNT(*) AS concept_rows FROM concept_amv_daily;            -- 期望 24466

-- (b) industry 表不再含任何 type='N'
SELECT COUNT(*) AS leftover_n
FROM industry_amv_daily a JOIN ths_index_catalog c ON c.ts_code=a.ts_code
WHERE c.type='N';                                                 -- 期望 0

-- (c) industry 表余量 = 原 I 行数
SELECT COUNT(*) AS industry_rows FROM industry_amv_daily;         -- 期望 36420

-- (d) 行级硬约束：concept 表 signal 不得为 NULL
SELECT COUNT(*) AS bad_signal FROM concept_amv_daily WHERE signal IS NULL;  -- 期望 0
```

> 基线行数会随后续增量同步变化；实现时以**迁移前即时查得的 N 行数**为 (a) 的期望值，
> 用 `industry 原总数 = 校验后 industry_rows + concept_rows` 做守恒校验，避免硬编码 24466 过期。

## PS1（`20260602_concept_amv_daily.ps1`）

```text
照既有 migrations/*.ps1 模板：
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -f /...  或
  Get-Content 该 .sql | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb
执行后再跑上面 (a)~(d) 四条校验并打印，任一不达期望即非零退出。
```

## 回滚

```sql
-- 把 concept 数据搬回 industry，再删表（仅在需要时）
INSERT INTO industry_amv_daily (...) SELECT ... FROM concept_amv_daily
  ON CONFLICT (ts_code, trade_date) DO NOTHING;
DROP TABLE IF EXISTS concept_amv_daily;
```

## 注意

- 实体 `ConceptAmvDailyEntity` 与本 SQL 的列/约束/索引名**必须逐一对应**，否则 TypeORM 同步报错
  （项目用 migration 脚本管理 schema，实体仅映射）。
- 迁移须在 `industry/sync` 改为只算 type='I' **之后或同批**上线，避免旧逻辑把 N 又写回 industry 表。
