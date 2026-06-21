# 01 · 方案决策与演进

## 1.1 动量定义选型

采用 **ROC（Rate of Change，变化率百分比）**：

```
ROC(N) = (Close_今日 − Close_N个交易日前) / Close_N个交易日前 × 100
```

项目里「动量」一词散在三处，定义各异，须区分：

| 名称 | 位置 | 公式 | 落库 | 进筛选/表格 |
|---|---|---|---|---|
| `momentum_20d/60d` | quant-pipeline（Python 因子） | 本质 ROC | `factors.daily_factors` | ❌ spec 标 Tier-3 P2 |
| `factor:'momentum'` | 回测引擎 | MA 周期排序打分 | ❌ 不落库 | ❌ 回测内部 |
| **ROC（本设计）** | strategy-conditions + 表格 | 见上 | ✅ 落库 | ✅ 筛选 + 表格 |

选 ROC（非 Momentum 价差）：无量纲、可跨标的比较，适合设阈值筛选与排序。与 quant-pipeline 的 `momentum_*` 语义一致（都是 ROC），但落点不同、互不冲突。

## 1.2 方案演进：从现算到落库

### 阶段一：方案 A（SQL 现算）—— 已实现并提交

初版**只做筛选**，ROC 不落库，`query-builder.ts` 里 OFFSET/LIMIT 子查询现算。已实现提交（commit `788faf5`）。设计要点：

- 单一 `roc` 字段 key + `rocParams.n`（默认 10，范围 1-250，任意可调）
- SQL `OFFSET n LIMIT 1` 子查询取 N 日前收盘，`(cur-prev)/prev*100` 现算
- A 股 `raw.daily_quote.qfq_close`，crypto `klines.close`
- 零 DB 迁移

### 阶段二：新增表格列 + 服务端排序需求

后续要求 ROC 同时作为**表格列显示 + 服务端排序**。实测发现现算在此场景不可行：

| 场景 | 现算耗时 | 原因 |
|---|---|---|
| 筛选扫描（命中页） | 快 | 只算命中标的 |
| 表格当列显示（当前页 50 行） | 112ms ✅ | 只算当前页 |
| **表格按 ROC 排序（全量 5536）** | **5400ms ❌** | **排序迫使全量算 ROC** |

性能瓶颈是**结构性的**：`ORDER BY roc` 要求 ROC 是已知值，数据库必须先给全部 5536 个标的算出 ROC 再排序。优化尝试均失败：窗口函数 `LAG` 692ms、`ROW_NUMBER` 11.8s。

### 阶段三：转向落库（方案 C）

性能实测证明「排序」要求 ROC 是**预存值**，非现算可解。决定：

- roc10 / roc20 / roc60 三档落库 `daily_indicator`（A 股）+ `klines`（加密）
- 筛选与表格**同源**（都读预存列），彻底消除口径分裂
- 筛选放弃「任意可调 N」，改为固定三档 {10, 20, 60}

## 1.3 落库档位：roc10 / roc20 / roc60

覆盖短/中/长三个动量窗口（10 日短动、20 日月动、60 日季动）。三档同时决定：表格列选项、筛选条件选项、DB 列数（3 列）、回填计算量。

## 1.4 关键决策表

| 决策点 | 选定 | 理由 |
|---|---|---|
| 动量定义 | ROC（变化率%） | 无量纲、可跨标的比 |
| 实现路径 | **落库（方案 C）** | 排序要求预存值，现算排序 5.4s 不可接受 |
| 落库档位 | roc10 / roc20 / roc60 | 短/中/长三窗口 |
| 计算位置 | `calcIndicators` + `calcIndicatorsStreaming` | A 股/加密共用统一计算入口，同步流程自动落库 |
| A 股取数口径 | 前复权 `qfq_close` | 与指标预算口径一致；不复权价会因除权产生假动量 |
| 加密取数口径 | `close` | 加密无复权概念 |
| 筛选与表格 | 同源（都读预存列） | 零口径分裂 |
| 筛选周期 | 固定三档 {10,20,60} | 落库列固定，放弃任意可调 N |
| 对已提交方案 A | 改造替换 | 删 query-builder 现算分支 → 读预存列；rocParams 改枚举 |

## 1.5 为什么不在策略条件模块自算（kdj-recompute 范式）

项目有三条指标处理路径：

```text
范式1 预存列（主流）         calcIndicators → daily_indicator/klines → 表格/筛选读
范式2 策略条件模块自算        kdj-recompute.service → 仅筛选 runner 用
范式3 筛选 SQL 现算          query-builder 子查询 → 仅筛选用（已实现的方案 A）
```

范式 2/3 **只服务筛选**，喂不到表格（表格取数走 `buildASharesBaseQuery`/`querySymbols`，不经过策略条件模块）。`kdj-recompute` 是预存列的**补充**（覆盖自定义 KDJ 参数场景），不是替代。ROC 要进表格且排序，**必须有预存列（范式 1）**。
