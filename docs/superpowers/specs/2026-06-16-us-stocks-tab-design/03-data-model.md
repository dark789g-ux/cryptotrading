# 03 · 数据模型（raw schema）

DDL 由 **NestJS migration（`.sql` + 同名 `.ps1`，docker exec）** 建表（项目主迁移机制，规避 Python Alembic 漂移）；Python 只读写、不管 DDL（与 A 股 `raw.*` 同例）。四个实体走**双注册**（业务模块 `forFeature` + `app.module.ts` 根 `entities[]`），漏后者运行时 `EntityMetadataNotFound`。

约定沿用 A 股：`bigserial id` PK + `UNIQUE(ticker, trade_date)`；`trade_date` 归一化为 `varchar(8) YYYYMMDD`（AkShare 给 `YYYY-MM-DD`，落库前转）；价格 `numeric(30,10)`（实体映射 string 防精度丢失）；指标 `double precision`；时间戳 `timestamptz DEFAULT now()`。**列名用 `ticker`**（非 A 股 `ts_code`，坦白命名差异）。

## 表结构

### raw.us_symbol（精选清单 + tracked）

```text
id            bigserial PK
ticker        varchar  UNIQUE NOT NULL      -- stock_us_daily 用的裸 ticker
name          varchar                       -- 中文名(CSV) 或 P2 从 AkShare 取
theme         varchar                       -- CSV「行业」主题, 面板筛选用
stock_type    varchar                       -- CSV「类型」(巨头型龙头/热点代表股/防御股)
tracked       boolean  NOT NULL DEFAULT false-- 仅 tracked 才抓日线/因子
list_date     varchar(8)  NULL              -- 预留, v1 可空
created_at / updated_at  timestamptz DEFAULT now()
```

### raw.us_daily_quote（不复权 + 派生前复权）

```text
id        bigserial PK
ticker    varchar NOT NULL
trade_date varchar(8) NOT NULL
open high low close  numeric(30,10) NOT NULL    -- 不复权(adjust=""), AkShare 直给
pre_close numeric(30,10) NULL                   -- 派生: 该 ticker 上一交易日 close (窗口函数 LAG)
pct_chg   numeric(30,10) NULL                   -- 派生: (close/pre_close-1)*100 百分数, 与 qfq_pct_chg 同量纲
volume    numeric(30,10) NULL                   -- AkShare 直给
qfq_open qfq_high qfq_low qfq_close  numeric(30,10) NULL   -- 派生: raw_x × adj_factor / 最新adj_factor
qfq_pre_close qfq_pct_chg  numeric(30,10) NULL             -- 派生
UNIQUE(ticker, trade_date)
-- 注: AkShare stock_us_daily 不给 amount/pre_close (见 02), 故无 amount 列、pre_close 为派生
```

### raw.us_adj_factor（后复权因子）

```text
id  bigserial PK
ticker varchar NOT NULL
trade_date varchar(8) NOT NULL
adj_factor numeric(30,10) NOT NULL    -- 派生: qfq_close/raw_close (见 02; hfq-factor 接口返回 None)
updated_at timestamptz DEFAULT now()
UNIQUE(ticker, trade_date)
```

### raw.us_daily_indicator（标准 TA 子集，输入 qfq）

```text
id bigserial PK
ticker varchar NOT NULL
trade_date varchar(8) NOT NULL
ma5 ma30 ma60 ma120 ma240  double precision
bbi  double precision
kdj_k kdj_d kdj_j  double precision
dif dea macd  double precision
atr_14  double precision
low_9 high_9  double precision
stop_loss_pct risk_reward_ratio  double precision
UNIQUE(ticker, trade_date)
```

> 不含 A 股专属的 砖块图(brick*)、活跃市值(amv_*)——美股不算、不建列。

## 不建的表（YAGNI / 简化，明示理由）

- **无 `us_sync_state` 脏区表**：每次同步对每只 ticker **全历史重抓+重算**（幂等 upsert），无跨日因子涟漪，省掉 A 股那套脏标记追踪。精选清单规模下成本可接受。
- **无 `us_trade_cal`**：交易日历直接用 `stock_us_daily` 返回数据自带的日期；不驱动「按日遍历」（美股是按 ticker 抓全历史）。

## us_symbol 播种（v1）

从 `doc/us_stocks_themes (1).csv` 播种（Python CLI 子命令，见 04）：
`股票代码→ticker`、`股票名称→name`、`行业→theme`、`类型→stock_type`、`tracked=true`。「理由」列不入库（YAGNI）。`ON CONFLICT(ticker) DO UPDATE` 更新 name/theme/stock_type，**不覆盖 tracked**。

## 实体文件（apps/server/src/entities/raw/）

`us-symbol.entity.ts` / `us-daily-quote.entity.ts` / `us-adj-factor.entity.ts` / `us-daily-indicator.entity.ts`，各 `@Entity({ schema: 'raw', name: 'us_*' })`。双注册到 `market-data/us-stocks/us-stocks.module.ts` 的 `forFeature` 与 `app.module.ts` 的根 `entities[]`。
