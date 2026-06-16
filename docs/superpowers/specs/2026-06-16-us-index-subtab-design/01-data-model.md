# 01 · 数据模型（migration + 实体 + 双注册）

← 返回 [index.md](./index.md)

落 **`raw` schema**（与 us-stocks 对齐，**非** ths-index-daily 的 public）。**无复权列、无 adj_factor 表**——比个股简单。

## 列类型权威源（已源头核验）

- quote 的 OHLCV：照 [us-daily-quote.entity.ts](../../../../apps/server/src/entities/raw/us-daily-quote.entity.ts) 用 **`numeric(30,10)` nullable**（个股 quote 即此类型）。
- indicator 17 列：照 [us-daily-indicator.entity.ts](../../../../apps/server/src/entities/raw/us-daily-indicator.entity.ts) 用 **`double precision` nullable**。
- 主键模式：`id bigserial` 自增 PK + `UNIQUE(index_code, trade_date)`（upsert 的 `ON CONFLICT (index_code, trade_date)` 依赖此唯一约束）+ 单列索引。
- `trade_date`：`varchar(8)` 存 `YYYYMMDD`（`.claude/rules/datetime.md`）。
- `updated_at`：`timestamptz NOT NULL DEFAULT now()`（个股表只有 updated_at、无 created_at；Python upsert 的 INSERT 不带 updated_at 列值，靠 DEFAULT 兜底）。

## <a id="raw-us_index_daily"></a>raw.us_index_daily

```text
id           bigserial      PRIMARY KEY
index_code   varchar(16)    NOT NULL      -- '.NDX'（原样存, 不去前导点）
trade_date   varchar(8)     NOT NULL      -- YYYYMMDD
open         numeric(30,10)
high         numeric(30,10)
low          numeric(30,10)
close        numeric(30,10)
volume       numeric(30,10)               -- amount 恒 0 丢弃, 不入库
updated_at   timestamptz    NOT NULL DEFAULT now()
CONSTRAINT uq_us_index_daily UNIQUE (index_code, trade_date)
CREATE INDEX ix_us_index_daily_code  ON raw.us_index_daily (index_code)
CREATE INDEX ix_us_index_daily_date  ON raw.us_index_daily (trade_date)
```

无 `pre_close`/`pct_chg`（AkShare 指数接口不给；K 线展示用不到；如需 pct 由前端/后续派生，v1 不做）。

## <a id="raw-us_index_indicator"></a>raw.us_index_indicator

17 列**逐字对齐** `raw.us_daily_indicator`（= Python `INDICATOR_KEYS`，见 [03](./03-python-pipeline.md)），保证 `calc_us_indicators` 输出 + 动态 `upsert_rows` 零改复用：

```text
id           bigserial      PRIMARY KEY
index_code   varchar(16)    NOT NULL
trade_date   varchar(8)     NOT NULL
ma5 ma30 ma60 ma120 ma240               double precision   -- 5 均线
bbi                                     double precision
kdj_k kdj_d kdj_j                       double precision
dif dea macd                            double precision
atr_14                                  double precision
low_9 high_9                            double precision
stop_loss_pct risk_reward_ratio         double precision
updated_at   timestamptz    NOT NULL DEFAULT now()
CONSTRAINT uq_us_index_indicator UNIQUE (index_code, trade_date)
CREATE INDEX ix_us_index_indicator_code ON raw.us_index_indicator (index_code)
CREATE INDEX ix_us_index_indicator_date ON raw.us_index_indicator (trade_date)
```

> ATR/low_9/high_9/stop_loss_pct/risk_reward_ratio 对「指数」语义略怪但无害（只是计算值）；为最大化代码复用，**整表照搬个股 17 列**，前端只渲染 MA/KDJ/MACD。

## migration 文件（`.sql` + 同名 `.ps1`）

命名照 [20260616120000-create-us-stocks.{sql,ps1}](../../../../apps/server/migrations/)。新建一对：

- `apps/server/migrations/<新时间戳>-create-us-index.sql`：`CREATE TABLE IF NOT EXISTS raw.us_index_daily (...)` + `raw.us_index_indicator (...)` + 上述 UNIQUE / INDEX。（`raw` schema 已存在，无需建 schema。）
- `apps/server/migrations/<新时间戳>-create-us-index.ps1`：照既有 ps1 模板——
  ```powershell
  Get-Content -Raw -Encoding utf8 $scriptPath |
    docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
  ```
  末尾跟 1~2 条 `docker exec -i ... psql ... -c "SELECT count(*) FROM raw.us_index_daily"` 做建表后校验。

## TypeORM 实体（双注册）

新建于 `apps/server/src/entities/raw/`，**镜像个股实体写法**：

- `us-index-daily-quote.entity.ts` → `@Entity({ schema: 'raw', name: 'us_index_daily' })`
  - `@PrimaryGeneratedColumn('increment', { type: 'bigint' }) id: string`
  - `@Index() @Column({ name: 'index_code' }) indexCode: string`
  - `@Index() @Column({ name: 'trade_date', length: 8 }) tradeDate: string`
  - `open/high/low/close/volume`: `@Column({ type: 'numeric', precision: 30, scale: 10, nullable: true }) ... : string`
  - `@UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date`
  - `@Unique(['indexCode', 'tradeDate'])`（类装饰器）
- `us-index-daily-indicator.entity.ts` → `@Entity({ schema: 'raw', name: 'us_index_indicator' })`
  - 同 id / indexCode / tradeDate / updatedAt 模式
  - 17 指标列：`@Column({ name: 'kdj_k', type: 'double precision', nullable: true }) kdjK: number` 等（属性名驼峰、`name` 显式蛇形，逐列照个股 indicator 实体）
  - `@Unique(['indexCode', 'tradeDate'])`

**双注册**（[reference: TypeORM 实体双注册](../../../../CLAUDE.md)）——除各自 module `forFeature` 外，须在 [app.module.ts](../../../../apps/server/src/app.module.ts) 根 `entities: [...]` 数组追加这两个新实体，否则编译绿但运行时 `EntityMetadataNotFound` 500。参照：个股四实体在 **L128-131**（源在 `entities/raw/`，与本模块同目录），同花顺指数三实体（含 `ThsIndexCatalogEntity`）在 **L171-173**（源在 `entities/ths-index-daily/`，**非** raw/——勿据此误以为 ths 实体也在 raw 目录）。

## 验证

- migration ps1 跑完，`\d raw.us_index_daily` / `\d raw.us_index_indicator` 列与类型与本文一致；UNIQUE 约束存在（upsert 依赖）。
- 实体 `pnpm --filter @cryptotrading/server build` 编译绿 + 后端启动不报 `EntityMetadataNotFound`。
