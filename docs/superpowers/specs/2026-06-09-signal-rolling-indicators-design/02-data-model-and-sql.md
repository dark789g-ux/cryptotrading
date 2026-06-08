# 02 · 数据模型与窗口 SQL

## 派生表 `signal_rolling_indicator`

仿 `stock_amv_daily`（`entities/active-mv/stock-amv-daily.entity.ts`、
`migrations/20260601120000-create-active-mv.sql`）。public schema（无前缀），与 `daily_quote` **1:1**
（每个有行情的 `(ts_code, trade_date)` 一行；窗口不满则该字段存 NULL）。

```sql
CREATE TABLE IF NOT EXISTS signal_rolling_indicator (
  id                bigserial PRIMARY KEY,
  ts_code           character varying NOT NULL,
  trade_date        character varying(8) NOT NULL,
  pos_120           double precision,          -- 120日区间位置 [0,1]，满120根才有值
  pos_60            double precision,          -- 60日区间位置  [0,1]，满60根
  close_ma60_ratio  double precision,          -- qfq收 / 60日qfq均价，满60根
  vol_ratio_60      double precision,          -- vol /(60日均量+1)，满60根
  vol_ratio_120     double precision,          -- vol /(120日均量+1)，满120根
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_signal_rolling_indicator_code_date UNIQUE (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_signal_rolling_indicator_code_date
  ON signal_rolling_indicator (ts_code, trade_date DESC);
```

> 唯一索引 `(ts_code, trade_date)` 既兜 upsert 冲突键，又支撑枚举器 / 实时扫描器按
> `d.ts_code=… AND d.trade_date=…` 的等值 join，无需额外 `(trade_date)` 索引。

**TypeORM 实体**（`entities/strategy/signal-rolling-indicator.entity.ts`，业务列 `double precision` nullable，
`@Unique(['tsCode','tradeDate'])` + `@UpdateDateColumn` timestamptz）。
⚠️ 新实体须**双注册**：所属 module `forFeature` **且** `app.module.ts` 根 `entities` 数组——
漏后者编译绿但运行时 `EntityMetadataNotFound` 500（项目历史坑）。

## 5 个指标的窗口公式

窗口按 **bar 根数**（`ROWS … PRECEDING`，等价 pandas `rolling(N)`，按行不按日历日）。
底部三项用 **qfq**（`qfq_high/qfq_low/qfq_close`），天量两项用**原始量** `vol`。
每项按各自窗口长度 `COUNT(*)` 门控：不满 N 根 → NULL（等价 pandas min_periods 不满 → NaN → 比较为 False）。

| 字段 | 公式 | 门控 | 模板对应 |
|------|------|------|---------|
| `pos_120` | `(qfq_close − low120) / (high120 − low120 + 1e-10)` | n120=120 | `is_bottom_120: <0.25` |
| `pos_60` | `(qfq_close − low60) / (high60 − low60 + 1e-10)` | n60=60 | `is_bottom_60: <0.20` |
| `close_ma60_ratio` | `qfq_close / ma60q` | n60=60 | `is_below_ma: <0.9` |
| `vol_ratio_60` | `vol / (avgvol60 + 1)` | n60=60 | `is_heavy: >2.0` |
| `vol_ratio_120` | `vol / (avgvol120 + 1)` | n120=120 | `is_heavy: >2.0` |

其中 `low/high_N = MIN/MAX(qfq_low|qfq_high) over wN`，`ma60q = AVG(qfq_close) over w60`，
`avgvolN = AVG(vol) over wN`。`+1e-10` / `+1` 与模板一致（防除零 / 平滑）。

## 回填 SQL

一次性全量回填（脚本或一次性 API，**不**写进 migration——migration 只管 schema）：

```sql
INSERT INTO signal_rolling_indicator
  (ts_code, trade_date, pos_120, pos_60, close_ma60_ratio, vol_ratio_60, vol_ratio_120)
SELECT ts_code, trade_date,
  CASE WHEN n120 = 120 THEN (qfq_close - low_120) / (high_120 - low_120 + 1e-10) END,
  CASE WHEN n60  = 60  THEN (qfq_close - low_60)  / (high_60  - low_60  + 1e-10) END,
  CASE WHEN n60  = 60  THEN qfq_close / NULLIF(ma60q, 0) END,
  CASE WHEN n60  = 60  THEN vol / (avgvol60  + 1) END,
  CASE WHEN n120 = 120 THEN vol / (avgvol120 + 1) END
FROM (
  SELECT ts_code, trade_date, qfq_close, vol,
    MIN(qfq_low)   OVER w120 AS low_120,
    MAX(qfq_high)  OVER w120 AS high_120,
    COUNT(*)       OVER w120 AS n120,
    AVG(vol)       OVER w120 AS avgvol120,
    MIN(qfq_low)   OVER w60  AS low_60,
    MAX(qfq_high)  OVER w60  AS high_60,
    COUNT(*)       OVER w60  AS n60,
    AVG(qfq_close) OVER w60  AS ma60q,
    AVG(vol)       OVER w60  AS avgvol60
  FROM raw.daily_quote
  WINDOW
    w120 AS (PARTITION BY ts_code ORDER BY trade_date ROWS BETWEEN 119 PRECEDING AND CURRENT ROW),
    w60  AS (PARTITION BY ts_code ORDER BY trade_date ROWS BETWEEN 59  PRECEDING AND CURRENT ROW)
) s
ON CONFLICT (ts_code, trade_date) DO UPDATE SET
  pos_120 = EXCLUDED.pos_120, pos_60 = EXCLUDED.pos_60,
  close_ma60_ratio = EXCLUDED.close_ma60_ratio,
  vol_ratio_60 = EXCLUDED.vol_ratio_60, vol_ratio_120 = EXCLUDED.vol_ratio_120,
  updated_at = now();
```

全量回填数据量大（A股全 history × 全市场），实现时**按 ts_code 分批**（每批数百只）跑上面 SQL，
避免单条巨查询占满内存 / 长事务；分批也便于进度上报。增量重算同款 SQL 限定 `ts_code` + `trade_date >= 起点`。

## 边界与口径说明

- **停牌日**：`raw.daily_quote` 停牌日**无行**（与 simulator 口径一致），故窗口 `ROWS 120` = 120 个**真实交易 bar**，
  与模板 `df` 的 `rolling(120)` 一致。
- **NULL qfq bar**：极少数缺 `adj_factor` 的行 qfq 为 NULL。`MIN/MAX/AVG` 自动跳过 NULL，但 `COUNT(*)` 仍计入，
  可能让窗口"名义满 120 实则 119 个有效值"。发生率极低，本设计接受；如需严格可改 `COUNT(qfq_close)` 门控（留待实现裁量）。
- **qfq 取列**：直接读 `raw.daily_quote.qfq_*`（已由 A股同步链算好落库，
  公式 `q.open*f.adj_factor/latest.adj_factor`，见 `market-data/a-shares/sync/a-shares-sync-dirty-ranges.ts:72-133`），**不**自行换算 adj_factor。
- **源列精度**：源列 `qfq_*`/`vol` 是 `numeric(30,10)`，派生列用 `double precision`，PG 隐式转换无损；
  `./04-usage-and-testing.md` 的 B 节平价比对按 double 精度（1e-6 容差）即可。

---
*硬事实核对（2026-06-09）：`daily_quote` 列 `open/high/low/close/pct_chg/vol/qfq_open/qfq_high/qfq_low/qfq_close`
见 `entities/raw/daily-quote.entity.ts:17-63`；派生表样板 `migrations/20260601120000-create-active-mv.sql`（`stock_amv_daily` 建表段）。*
