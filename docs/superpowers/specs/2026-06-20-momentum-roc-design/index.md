# 动量（ROC）指标 设计

- 日期：2026-06-20
- 范围：筛选条件 + 表格列 双场景新增技术指标「动量（ROC，变化率百分比）」，落库预存
- 状态：已 brainstorming、待实现
- 关联 spec：[`../2026-06-17-kdj-custom-params-strategy-conditions-design.md`](../2026-06-17-kdj-custom-params-strategy-conditions-design.md)（KDJ 自定义参数范式）

## 背景

在标的筛选模块（`strategy-conditions`）与标的表格（`ASharesPanel` / `CryptoSymbolsPanel`）中新增技术指标**动量**。

**ROC 定义**：`ROC(N) = (Close_今日 − Close_N个交易日前) / Close_N个交易日前 × 100`，无量纲百分比，可跨标的比较。「N 日前」指 N 个交易日（非自然日），停牌日不计入。

## 方案演进（重要）

本设计经历一次**根本性方案转向**，理解演进史才能理解最终形态：

1. **方案 A（SQL 现算）** —— 初版只做筛选，ROC 不落库，query-builder 里 OFFSET/LIMIT 子查询现算。已实现并提交（commit `788faf5`）。
2. **新增表格列 + 服务端排序需求** —— 实测发现现算在「按 ROC 排序」场景要算全量 5536 个 ROC，耗时 5.4 秒（不可接受）。窗口函数 692ms、ROW_NUMBER 11.8s 均不行。
3. **转向落库（方案 C）** —— 性能实测证明「排序」要求 ROC 是预存值，非现算可解。决定 roc10/20/60 三档落库 `daily_indicator`（A 股）+ `klines`（加密），筛选与表格**同源**，彻底消除口径分裂。
4. **改造已提交的方案 A** —— 筛选模块从「现算任意 N」改为「读预存列固定三档」，删除 query-builder 的现算分支。

> ⚠️ commit `788faf5` 的现算实现将被本设计的落库方案**替换**。筛选模块的 ROC 分支要从「OFFSET 子查询现算」改为「读 `i.roc10/20/60` 预存列」，`rocParams` 从任意数改为枚举 {10,20,60}。

## 子文档清单与阅读顺序

| 序 | 文档 | 内容 |
|---|---|---|
| 01 | [方案决策与演进](./01-decisions.md) | 动量定义选型、方案 A→C 转向、性能实测、落库档位、关键决策表 |
| 02 | [计算层与 DB 模型](./02-calc-and-db.md) | `calcIndicators`/`calcIndicatorsStreaming` 加 ROC、DB 迁移、实体字段、回填 |
| 03 | [筛选模块改造](./03-screener-refactor.md) | query-builder 删现算分支→读列、rocParams 改枚举、前端 conditionFieldMeta 改三档 |
| 04 | [表格列与前端](./04-table-columns.md) | 主 SQL SELECT roc、排序映射、ASharesPanel/CryptoSymbolsPanel 列定义 |
| 05 | [任务拆分与验收](./05-tasks-and-acceptance.md) | 实施批次、验收标准、风险 |

**建议阅读顺序**：01 → 02 → 03 → 04 → 05。01 是理解全貌的前提（尤其方案演进史）；02 是落库基础，03/04 依赖 02 的产物；05 最后。

## 跨文档引用约定

统一用相对路径 + 锚点，如 `./02-calc-and-db.md#db-迁移`。
