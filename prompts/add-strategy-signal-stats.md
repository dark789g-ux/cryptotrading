# 任务交接：新增「信号前向统计」功能（买/卖条件触发后的胜率、盈亏比）

> 本文是上一会话的需求交接。上一会话只做了**模块定位摸底**（已派 Explore 子代理核实真实代码），**未写任何实现代码**。本会话目标：实现该功能。
> **按本项目约定：动手实现前先走 `/brainstorming` 把设计敲定（HARD-GATE），经用户批准后再用 `subagent-driven-development` 实现。本文给的是已核实的事实底座 + 已定方向 + 待设计敲定的开放问题。**

## 一句话需求
做一个**简单的测试**：给定用户自定义的**买入策略（条件）**，统计其历史触发后**第二天**（或自定义 N 天）的**胜率、盈亏比**等指标；卖出策略同理。面向 **A 股**，用**自定义条件信号**（不是完整时序回测）。

## ★已定方向（上一会话与用户确认）
- **放 `apps/server/src/strategy-conditions/` 下，新增一个 `signal-stats` 子服务**（与现有 `runner` 平行）。
- **不建顶层新模块**（条件模型 + A 股数据接入都在 strategy-conditions 里，抽出去会循环依赖/数据复制）。
- **不放 `backtest/`**（它是 crypto-only + 重量级时序回测，见下）。
- **不依赖 Python `apps/quant-pipeline`**：server 侧用 `raw.daily_quote + adj_factor` 自算后复权前向收益，口径对齐 quant 的 `fwd_ret` 即可，保持 server 自洽。
- **保持轻量**：只做"信号 → 前向统计"，**不碰仓位管理/凯利/止损追踪**（那是 backtest 的活）。

---

## 现状摸底（已核实，file:line 为证，别凭模块名猜）

| 模块 | 职责 | 有无胜率/盈亏比 | 市场/数据源 |
|---|---|---|---|
| `backtest/` | 完整时序回测（逐根 K 线、仓位管理、凯利、止损追踪） | **已有** `winRate/avgWinReturnPct/avgLossReturnPct/maxDrawdownPct/sharpeAnnualized/totalReturnPct`（`engine/report.ts:21-91`，`calcStats()`），**缺 profitFactor** 但有原料 | **仅 crypto**（`klines` 表），**不接 A 股** |
| `strategies/` | 策略配置纯 CRUD（`StrategyEntity.params = BacktestConfig`），不算东西 | 无 | — |
| `strategy-conditions/` | A 股**当日截面**扫描：按条件找"今天命中的票" | **无** | A 股 `raw.daily_indicator ⋈ daily_quote/daily_basic/stock_amv_daily`；也支持 `klines`(crypto) |
| `apps/quant-pipeline`(labels) | `fwd_ret_h1`=**次日收益**、`strategy-aware`=固定出场规则的 value/hold_days/exit_reason | 概念上**正是"买入信号后的前向结果"**；但 Python 侧、为 ML 物化、出场规则固定、server 无读接口 | A 股 `factors.labels` |

**关键事实（决定怎么实现）**
- `strategy-conditions` 现有 `runner.executeRun`（`strategy-conditions.runner.ts:23-141`）**只扫最新一天**、且 `runner.ts:150` **每次 run 先 `delete` 再写**（只存最新快照、无历史、无时间维度）。→ **新功能要新增"遍历历史日期区间、记录每次触发后前向收益"的能力，这是和现有 runner 的本质差别（平行新路径，不是改 runner）。**
- 条件模型 `StrategyConditionItem { field, operator, value?, compareField? }`，operator 支持 `gt/gte/lt/lte/eq/neq/cross_above/cross_below`（`strategy-conditions.query-builder.ts`）。字段映射到 A 股 `raw.daily_indicator/daily_quote/daily_basic/stock_amv_daily` 列。
- 结果存储可类比 `entities/strategy/strategy-condition-hit.entity.ts`（新建一张统计结果表）。
- **别重复造轮子**：crypto 胜率/均盈/均亏在 `backtest/engine/report.ts` 已有（可参考算法）；A 股次日收益口径在 quant `forward_returns.py`(`load_forward_returns`)、`labels/fallback.py`(fwd_ret) 已有（参考口径，别 import）。

---

## 要新增的能力（实现要点）
1. **历史信号枚举**：输入买入条件集（可选卖出条件集）+ 历史日期区间 + 标的池 → 遍历每个交易日，用 query-builder 的条件匹配找出每个 `(signal_date, ts_code)` 触发。
2. **前向收益**：对每个触发，算前向结果：
   - 买入"第二天" → 次日**后复权**收益（`raw.daily_quote.close * adj_factor`，T+1 入场口径，注意停牌/涨停可入场性——设计时定是否过滤，参考 quant 的次新股/涨停/停牌过滤口径）。
   - 自定义 N 天 / 卖出策略的前向口径 → 设计时定。
3. **聚合指标**：胜率(%正)、盈亏比、平均收益、样本数（必要时平均持仓天数、最大回撤）。
4. **落库**：新建结果表存统计（migration：`apps/server/migrations/*.sql` + 同名 `.ps1`，内置 `docker exec`）。
5. **API + 前端（设计时定是否要）**：controller 暴露 `/api/...`；前端可能在 `apps/web/src/views/strategy/` 加页面/触发入口。

---

## ★设计阶段必须敲定的开放问题（brainstorming 时逐个问用户）
1. **「盈亏比」定义**：profit factor（Σ盈利/Σ亏损）还是赔率（平均盈利/平均亏损）？或两者都出。
2. **「买入后第二天」口径**：T 日触发 → T+1 开盘买、T+2 收盘卖？还是 T+1 收盘单日收益？后复权怎么取（用 adj_factor 还是已复权列）？
3. **卖出策略的前向口径**：卖出信号统计的是"卖出后避免了多少下跌"还是别的？语义需用户明确。
4. **第二天 vs 自定义 N 天**：固定次日，还是可配 horizon（对齐 quant 的 fwd_horizon）？
5. **可入场性过滤**：停牌、一字涨停（买不进）、次新股（上市不足 N 日）是否剔除？口径是否对齐 quant（exchange='SSE' 日历、新股 60 交易日等）。
6. **结果落库 vs 即时算**：存历史统计表（可查可比），还是每次即时返回不落库？
7. **是否需要前端页面/API**，还是先做后端 service + 单测即可。
8. **标的池**：全市场？自选？指定列表？
9. **与现有 `strategy-conditions` UI/实体的复用边界**：共用 `StrategyConditionEntity` 还是新实体存这套"买入条件+卖出条件+horizon"配置。

---

## 硬约束 / 项目规范（务必带走）
- **不假设、暴露权衡、用中文**（CLAUDE.md）。多解读都列出，不要悄悄选一个。
- **接口名以官方文档为准**：涉及 Tushare 字段/口径先触发 `tushare-sync-dev` skill 查文档；进硬断言/SQL 前自查实体或真 DB 一条（`.claude/rules/data-integrity.md`）。子代理报告=二手，不直接进硬断言。
- A 股口径：交易日历 `raw.trade_cal WHERE exchange='SSE'`；后复权用 `adj_factor`；停牌/涨停/次新股过滤口径对齐 quant。
- **后端 `dev` 是 `nest start`（无 watch）**：改 `apps/server` 代码后**必须重启后端进程**新路由/改动才生效（前端 vite 有 HMR）。
- DB schema 调整须随附 `docker exec` 可执行脚本（`apps/server/migrations/*.sql` + 同名 `.ps1`）。新增 TypeORM 实体须**同时**加 module `forFeature` + `app.module` 根 `entities` 数组（漏后者编译绿但运行时 `EntityMetadataNotFound` 500，见记忆 `project_typeorm_entity_dual_registration`）。
- Vue 单文件 ≤500 行（`lint:quant-lines` 在 CI 强制 quant 目录；其它目录也遵循 ≤500 行规范）。
- 终端 Windows PowerShell（禁 `&&`，用 `;`）；终端 GBK 但**所有源文件 UTF-8**，文件 I/O 显式 `encoding='utf-8'`，对象键名用英文。
- 常用命令：`pnpm --filter @cryptotrading/server build`；后端单测 `pnpm --filter @cryptotrading/server exec jest <pattern>`；前端类型检查 `pnpm --filter @cryptotrading/web type-check`；查 DB `docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`。
- 派 Explore 子代理显式传 `model: sonnet`。

## 建议执行流程
1. `/brainstorming`：以本文为输入，先派子代理细查 `strategy-conditions/` 的 entity/DTO/runner/query-builder/controller + 前端 strategy 视图（点对点确认接口），再逐个问上面 9 个开放问题，出设计 spec（`docs/superpowers/specs/YYYY-MM-DD-signal-stats-design...`）。
2. 用户批准 spec 后 → `subagent-driven-development` 按文件域切批次实现（后端 entity+migration / service / controller / 单测；如需则前端页面）。
3. 验证：jest 单测；真机 `docker exec` 抽查统计结果合理（找一两个已知信号手算核对）；重启后端跑端到端。

## 参考文件位置
- 目标模块：`apps/server/src/strategy-conditions/`（`strategy-conditions.runner.ts:23-141,150`、`strategy-conditions.query-builder.ts`、controller/service/module）
- 条件结果实体范式：`apps/server/src/entities/strategy/strategy-condition-hit.entity.ts`
- 指标算法参考（crypto，别直接复用）：`apps/server/src/backtest/engine/report.ts:21-91`
- A 股前向收益口径参考（Python，别 import，仅对齐口径）：`apps/quant-pipeline/.../forward_returns.py`（`load_forward_returns`）、`labels/fallback.py`(fwd_ret)
- migration 范式：`apps/server/migrations/*.sql` + 同名 `.ps1`
- 前端策略视图：`apps/web/src/views/strategy/`
