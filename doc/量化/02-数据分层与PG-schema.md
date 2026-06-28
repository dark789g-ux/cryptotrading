# 02 数据分层与 PG schema 设计

> **查库场景**见 [doc/db/quick-guide/](../db/quick-guide/index.md)。本文档保留数据分层原则；表结构按需 `\d schema.table` 查真库。

↩ [返回索引](00-index.md)

---

## 2.1.1 三层职责分离

整套训练管线按职责严格分三层（参考 medallion 架构），全部落 PostgreSQL，按 schema 隔离：

| 层 | PG schema | 数据来源 | 是否可重新生成 | 是否可修改 |
|---|---|---|---|---|
| 源头层（bronze） | `raw` | TuShare API 原样落地 | **否**（需重调外部接口） | **永不修改** |
| 计算层（silver） | `factors` | 由 raw 派生 | 是（重跑因子函数） | 因子代码升版后整层重建 |
| 训练层（gold） | `ml` | factors + labels join | 是 | 标签定义改了就重建 |

**核心原则**：raw 层是"从 TuShare 拿到了什么"的不可变证据；任何因子 bug、模型异常、监管追溯都要回到 raw 层验证。**没有 raw 层 = 没有 ground truth**。

---

## 2.1.2 为什么需要 raw 层（而不是每次现拉 TuShare）

| 场景 | 有 raw 层 | 无 raw 层 |
|---|---|---|
| 因子 bug 重算 | 读本地 PG，30 秒 | 重调 TuShare 数小时，**可能拿到不同结果** |
| TuShare 历史被修正（财务更正、复权重写） | 有当时快照证据 | **无法溯源** |
| 线上事故复现 | 100% 可复现 | 复现不了 |
| PIT 正确性验证 | 有 ground truth 对比 | 只能猜 |
| 拉数据 vs 算因子的迭代节奏 | 解耦并行 | 耦合串行 |

---

## 2.1.3 raw schema 设计原则

1. **一接口一张表，字段 1:1 镜像 TuShare**
   - 例：`raw.daily_quote` 列名 = TuShare `daily` 接口返回列名
   - 禁止落库时改名、改类型、做计算
   - TuShare 扩字段时只需 `ALTER ADD COLUMN`，不影响下游

2. **永不 UPDATE，只 INSERT 或 UPSERT**
   - 主键 = TuShare 接口的天然唯一键（一般是 `ts_code + trade_date`）
   - 同一行重拉走 upsert，但记 `updated_at`
   - 应用项目 CLAUDE.md 规范：TypeORM upsert 前必须按 `conflictKeys` 去重，避免 `ON CONFLICT DO UPDATE` 同批次冲突

3. **加审计列**
   - `ingested_at TIMESTAMPTZ DEFAULT now()` — 首次落库时间
   - `updated_at TIMESTAMPTZ` — 最近覆盖时间
   - 应用项目 CLAUDE.md 规范：所有时间列用 `timestamptz`，禁 `timestamp`

4. **A 股 trade_date 用 CHAR(8) 存 YYYYMMDD 格式**
   - 应用项目 CLAUDE.md 规范：`trade_date` 存储为 Tushare 标准 `'YYYYMMDD'`，禁直接 `new Date(tradeDate)`
   - 转 `Date` 时插入分隔符：`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`

5. **按月分区**
   - 5 年 × 5000 股 × 250 日 ≈ 600 万行/表
   - `PARTITION BY RANGE (trade_date)` 后单分区查询性能差 10-100 倍
   - 老分区（> 3 年）`DETACH` 后可考虑归档对象存储

6. **关闭 TypeORM synchronize，schema 用迁移脚本管理**
   - 应用项目 CLAUDE.md 规范：`synchronize: false`
   - 涉及数据库调整时附 `docker exec crypto-postgres psql ...` 格式的可执行脚本

7. **同步任务必须显式 warn 空数据**
   - 应用项目 CLAUDE.md 规范：`payload.data === null` 与 `data.items.length === 0` 是两条路径，都要 warn
   - fetcher 返回 0 行时 push 到 `failedItems`（apiName 标 `xxx_empty`，例 `daily_empty`/`adj_factor_empty`）

---

## 2.1.4 P0 接口对应的 raw 表清单

按 [06-TuShare 接口清单](06-TuShare接口清单.md) 的 P0 列表，raw schema 至少要这 9 张表（旧 `raw.ts_*` 命名已废弃，现用去前缀 snake_case）：

| 表名 | 对应 TuShare 接口 | 主键 | 分区 |
|---|---|---|---|
| `public.a_share_symbols` | `stock_basic` | `ts_code` | 无（小表，catalog 在 public） |
| `raw.trade_cal` | `trade_cal` | `(cal_date, exchange)` | 无 |
| `raw.daily_quote` | `daily` | `(ts_code, trade_date)` | 按月 |
| `raw.daily_basic` | `daily_basic` | `(ts_code, trade_date)` | 按月 |
| `raw.adj_factor` | `adj_factor` | `(ts_code, trade_date)` | 按月 |
| `raw.stk_limit` | `stk_limit` | `(ts_code, trade_date)` | 按月 |
| `raw.suspend_d` | `suspend_d` | `(ts_code, suspend_date)` | 无 |
| `raw.index_classify` | `index_classify` | `(index_code, level)` | 无 |
| `raw.index_member` | `index_member_all` | `(index_code, con_code, in_date)` | 无 |

P1 / P2 接口对应表按相同规范扩展。查库场景见 [doc/db/quick-guide/](../db/quick-guide/index.md)。

---

## 2.1.5 何时考虑混合 PG + Parquet

| 场景 | 处理 |
|---|---|
| 单表 < 50 GB / 行数 < 1 亿 | **纯 PG**（A 股 5 年全量在此范围内） |
| 全表 sequential scan 训练读取慢 | 定期导出 dump 的 Parquet 供 pandas 直读 |
| 历史数据归档（> 5 年） | 老分区 `DETACH` → 落 Parquet → `DROP` 老分区 |
| 跨机器训练 | 单 PG 实例瓶颈时考虑文件分发 |

**A 股 5 年 + 7000 积分场景下，纯 PG 完全够用**，本 SPEC 不引入 Parquet。

---

## 2.1.6 数据流水线总览

```
TuShare API
    │
    ▼  [按日增量同步，0.15 秒/次限频]
PG schema: raw.*           ← 永不修改的源头快照
    │
    ▼  [因子函数 + PIT 测试，按 factor_version 隔离]
PG schema: factors.*       ← 因子宽表 + 中性化版本
    │
    ▼  [join + 标签生成 + 横截面归一化]
PG schema: factors.feature_matrix  ← 训练矩阵
    │
    ▼  [LightGBM 训练 + Optuna 调参]
文件系统: models/v{N}/model.txt + feature_meta.json
    │
    ▼  [每日推理，结果回写 PG]
PG schema: ml.scores_daily  ← 推理输出
```

---

↩ [返回索引](00-index.md) | 上一篇：[01 训练体系蓝图](01-训练体系蓝图.md) | 下一篇：[03 PIT 与数据质量](03-PIT与数据质量.md)
