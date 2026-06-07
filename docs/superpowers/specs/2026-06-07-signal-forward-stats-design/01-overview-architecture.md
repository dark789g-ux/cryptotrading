# 01 · 架构总览与数据流

[← 返回 index](./index.md)

## 1.1 模块位置与边界

新增子服务目录 `apps/server/src/strategy-conditions/signal-stats/`，与现有 `runner` 平行，**不建顶层新模块**（条件模型 + A 股数据访问都在 `strategy-conditions` 内，抽出去会循环依赖 / 数据复制）。

与现有模块的职责边界：

| 模块 | 职责 | 本功能关系 |
|---|---|---|
| `strategy-conditions`（现有 runner） | A 股当日截面扫描，只存最新快照 | **复用** query-builder / types 字段映射；**不改** runner/service |
| `backtest/` | crypto-only 完整时序回测、仓位管理、凯利下单 | 仅**参考** `report.ts` 指标算法，不接入 |
| `apps/quant-pipeline`（Python labels） | ML 物化的 `fwd_ret` / `strategy-aware` | 仅**对齐口径**，不 import、不依赖 |

## 1.2 数据流

```text
┌─────────────┐   POST /run    ┌──────────────────────────────────────┐
│ 前端        │ ─────────────▶ │ signal-stats.service (异步 run)        │
│ SignalStats │                │  ┌────────────────────────────────┐   │
│ View        │ ◀─ 进度轮询 ── │  │ 1. 信号枚举 (历史区间逐交易日)  │   │
└─────────────┘                │  │    复用 query-builder 买入WHERE │   │
                               │  ├────────────────────────────────┤   │
                               │  │ 2. 逐笔持仓模拟 simulateExit    │   │
                               │  │    入场T+1开盘→出场(fixed_n/cond)│   │
                               │  │    + 入场过滤(停牌/涨停/次新)    │   │
                               │  ├────────────────────────────────┤   │
                               │  │ 3. 指标聚合 calcSignalStats     │   │
                               │  │    胜率/赔率/PF/凯利/最差单笔    │   │
                               │  └────────────────────────────────┘   │
                               │            │ 落库                      │
                               │            ▼                           │
                               │  signal_test_run + signal_test_trade   │
                               └──────────────────────────────────────┘
        数据源(只读, @InjectDataSource 原生 SQL):
        直接读: raw.daily_quote(qfq_*) · raw.stk_limit
                raw.trade_cal(SSE) · public.a_share_symbols
        间接(经 query-builder 条件 WHERE 命中): raw.daily_indicator · raw.daily_basic
```

## 1.3 与现有 runner 的本质差别

| 维度 | 现有 runner | 本功能 signal-stats |
|---|---|---|
| 锚定日 | 硬编码最新一天 `MAX(trade_date)` | 遍历历史区间逐交易日 |
| 时间维度 | 无（hit 表无 trade_date） | trade 表带 signal_date/buy_date/exit_date |
| 历史 | 每次 delete 重写，只留最新 | run 保留历史多次，可对比 |
| 输出 | 命中票清单 | 前向收益 + 聚合统计指标 |
| 持仓模拟 | 无 | 逐笔 T+1 入场 → 出场模拟 |

## 1.4 复用点（避免重复造轮子）

1. **query-builder**（`strategy-conditions.query-builder.ts`）：
   - `buildAShareQuery()` 把 `StrategyConditionItem[]` 翻译成参数化 WHERE 片段，字段映射表在 `strategy-conditions.types.ts:4-46`。
   - `cross_above/cross_below` 已有"取前一交易日值"子查询（`query-builder.ts:158-193`，用 `SELECT MAX(trade_date) WHERE trade_date < i.trade_date`，不假设连续日期）。
   - **复用方式**：买入信号枚举与卖出条件逐日判定都用它生成 WHERE，外层把"锚定日"从最新天换成遍历日（详见 [02 文档](./02-simulation-and-semantics.md#信号枚举)）。
   - **已知限制**：`cross` 算子只支持 `daily_indicator`（`i.`）表内字段互比，`q./m./sa.` 表字段调 cross 会被 warn 跳过（`query-builder.ts:159-175`）。前端编辑器需沿用此约束。

2. **数据访问**：通过 `@InjectDataSource()` 直接执行原生 SQL 访问 `raw.*` / `public.*`，无需 import 其它 module（与现有 runner 同模式）。

3. **指标算法参考**：`backtest/engine/report.ts:67-78` 的胜率/均盈/均亏算法（`winningFull/losingFull` 分组 + 算术均值）；profit factor 现有代码缺但 `reduce` 两行可补。**仅参考公式，不复用代码**（crypto trade 结构不同）。

4. **前端条件编辑器**：`apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue` 完整可复用（field/operator/compareMode/value/compareField），配买入和卖出两组条件。

## 1.5 异步运行与进度（对齐现有范式）

沿用 runner 的异步执行 + 轮询进度范式（`runner.ts:23-62`）：
- `POST /:id/run` 立即返回，后台 async 跑。
- run 记录 `progress_scanned / progress_total / status`，前端每 500ms 轮询 `GET /:id/run/progress`（对齐 `stores/strategyConditions.ts:61` 范式）。
- 进度粒度：按"已处理交易日数 / 总交易日数"推进。

[← index](./index.md) ｜ [下一篇：02 模拟与口径 →](./02-simulation-and-semantics.md)
