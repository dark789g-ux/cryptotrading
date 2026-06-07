# 信号前向统计（Signal Forward Stats）设计 spec

> 给定用户自定义的**买入条件**，统计其历史触发后按指定出场规则平仓的**胜率、赔率、profit factor、凯利 f\*** 等前向指标。面向 **A 股**，用条件信号 + 轻量逐笔持仓模拟（非完整时序回测）。

## 背景与目标

现有 `strategy-conditions` 模块只做 A 股**当日截面**扫描（"今天命中的票"），`runner.executeRun` 硬编码只扫最新一天（`apps/server/src/strategy-conditions/strategy-conditions.runner.ts:103`），且 `service.run()` 每次先 `delete` 再写、只存最新快照、无历史维度（`strategy-conditions.service.ts:150`）。

本功能新增**平行新路径**：遍历历史日期区间，对每个 `(signal_date, ts_code)` 触发做"T+1 入场 → 出场"逐笔模拟，算前向收益并聚合成统计指标，落库可查可比。**不碰仓位管理/凯利下单/止损追踪**（那是 `backtest/` 的活），只做"信号 → 前向统计"。

**已确认范围（与用户 11 项 + 2 权衡点敲定）**：

| 维度 | 决策 |
|---|---|
| 位置 | `apps/server/src/strategy-conditions/signal-stats/` 子服务（与 runner 平行） |
| 入场 | T+1 开盘价（`qfq_open`） |
| 出场 | ①`fixed_n` 固定持有 N 天→T+1+N 收盘价；②`strategy` 卖出条件触发 + `maxHold` 兜底 |
| 前向收益 | 用 `qfq_*` 直接算，`ret = exit_price/buy_price − 1`（毛收益） |
| 入场过滤 | 全开对齐 quant：停牌（隐式）/ 一字涨停 / 次新(<60 交易日) |
| 指标 | 样本数、胜率 p、均盈、均亏、赔率 b、profit factor、凯利 f\*、均持仓天数、最差单笔 |
| 落库 | 三级表：方案 / 聚合统计(留历史) / 逐笔明细 |
| 标的池 | 默认全市场 + 可指定 ts_code 列表/自选 |
| 配置实体 | 新建独立 `signal_test` 表 |
| 前端 | 一并做：复用 `StrategyConditionBuilder` + 新 `SignalStatsView` |

## 子文档清单与阅读顺序

按以下顺序阅读：

1. [01-overview-architecture.md](./01-overview-architecture.md) — 架构总览、数据流、与现有模块边界、复用点。
2. [02-simulation-and-semantics.md](./02-simulation-and-semantics.md) — **核心**：信号枚举、入场过滤口径、逐笔出场模拟、前向收益与指标公式。
3. [03-data-model.md](./03-data-model.md) — 三张新表 DDL、TypeORM 实体、双注册、migration 范式。
4. [04-api-and-frontend.md](./04-api-and-frontend.md) — DTO、controller 路由、service 方法、前端页面与组件复用。
5. [05-error-testing-tasks.md](./05-error-testing-tasks.md) — 错误处理、单测清单、真机验证、按文件域切分的实现任务批次。

## 跨文档引用约定

- 文档间引用统一用相对路径 + 锚点，例：`[出场模拟](./02-simulation-and-semantics.md#出场模拟)`。
- 代码引用统一 `path:line` 格式（可点击），例：`strategy-conditions.query-builder.ts:158`。
- 所有列名 / 表名 / 字段后缀均已落真 DB 一条样本核对（见 02 文档脚注），**实现时进硬断言前仍须自查**（`.claude/rules/data-integrity.md`）。

## 关键事实底座（已落 DB / file:line 核实）

- `raw.daily_quote.qfq_open/qfq_close` **100% 填充**（4,409,123 行全非空，20230103~20260604），可直接算前向收益，省 JOIN `adj_factor`。
- `qfq` 比值 ≡ `close*adj_factor` 比值（前后复权只差全局常数），口径仍对齐 quant `fwd_ret`。
- 入场过滤依赖表就位：`raw.stk_limit(up_limit)`、`raw.suspend_d(suspend_type S/R)`、`public.a_share_symbols(list_date)`。
- `query-builder` 的 `cross_above/cross_below` 已有"取前一交易日值"能力（`strategy-conditions.query-builder.ts:158-193`），可复用。
