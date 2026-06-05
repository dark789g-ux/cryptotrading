# 量化「策略管理」模块设计（v1）

> 在量化模块下新建**策略定义注册中心**（`factors.strategy_definitions`，Alembic 管表），
> 策略 = 一组**可配置出场规则列表**；标签 `strategy_aware` 改为强引用
> `{strategy_id, strategy_version}`；Python pipeline 按引用加载规则链回算 A 股日频收益。
> 完全对标 2026-06-05 刚落地的标签库（label_definitions）。

本 spec 因覆盖 DB / Python / NestJS / 前端四层 + 测试，已拆为目录形态。本文件是入口与导航。

---

## 1. 背景与目标

「固定策略收益」标签**当前已落地**，但策略本身写死在 Python（`strategy/exit_rules.py`），
前端只能调一个 `max_hold_days`。目标：把写死的单一策略升级成**可管理的命名注册中心**——
用户在前端定义多个命名策略（各自不同的出场规则组合），标签的「固定策略收益」可引用任意一个。

**为什么不复用现有 `strategies/`+`backtest/`**：那是纯加密货币、TS 引擎、交互式回测；
标签用例是 A 股、Python、日频离线——市场 / 语言 / 执行域都不同，引擎无法直接复用。
唯一可借鉴的是 `strategy-conditions/` 的条件语言设计模式（本 v1 暂不引入入场条件，故仅作蓝本）。

## 2. 锁定决策（来自 brainstorming 问答）

| # | 决策 | 取舍 |
|---|------|------|
| D1 | 新建量化域策略注册中心（A 股 / Python 执行） | 不复用 crypto 回测引擎 |
| D2 | 策略 = 结构化可配置**出场规则列表**（rule list） | 入场/选股、调仓/组合 **不在 v1** |
| D3 | 标签 `strategy_aware` 强引用 `base_params={strategy_id, strategy_version}` | `max_hold_days` 下沉进策略 |
| D4 | `exit_rules=[{type, params}]`，first-match，**5 种 type** | stop_loss / ma_break / max_hold / take_profit / trailing_stop |
| D5 | **不可变版本**：改规则=新版本，PATCH 只改展示字段 | 保标签可复现 |
| D6 | scheme legacy-alias：`default_exit@v1`→`"strategy-aware"`；其它→`"strategy-aware__{id}_{ver}"` | 守历史数据不漂移 |
| D7 | 种子 `default_exit@v1` = 现写死规则；现有标签 `strategy_aware_default@v1` 迁移引用它 | 单一真相源 |
| D8 | 四层全做（DB / Python / NestJS / 前端） | 含 take_profit/trailing_stop 的模拟器改造 |

## 3. 子文档清单与阅读顺序

按下列顺序阅读：

1. [`01-architecture-and-scope.md`](./01-architecture-and-scope.md) — 总览、数据流、两条 label 入口、命名避碰、YAGNI 边界。
2. [`02-data-model-and-migration.md`](./02-data-model-and-migration.md) — `strategy_definitions` 表、exit_rules JSON schema、版本模型、scheme 编码、Alembic 迁移。
3. [`03-python-pipeline.md`](./03-python-pipeline.md) — build_exit_rules 工厂、新 Rule 类、ExitState/模拟器改造、runner SQL、scheme codec、接线。
4. [`04-backend-nestjs.md`](./04-backend-nestjs.md) — 实体 / CRUD / DTO / 标签校验接线。
5. [`05-frontend.md`](./05-frontend.md) — 策略管理页、ExitRulesEditor、标签弹框策略选择器、路由 / 菜单 / api。
6. [`06-testing-and-tasks.md`](./06-testing-and-tasks.md) — 校验、测试（回归 + 新规则）、任务切分、上线步骤。

跨文档引用统一用相对路径 + 锚点，例如 [`./02-data-model-and-migration.md#4-scheme-编码`](./02-data-model-and-migration.md#4-scheme-编码)。

## 4. 源头已核对事实（落 spec 前亲读，注明出处）

凡进 migration / 硬编码常量 / scheme 约定的事实，均已落源码核对（CLAUDE.md `data-integrity` 硬规矩）：

| 事实 | 出处 |
|------|------|
| `factors.labels` PK = `(trade_date, ts_code, scheme)` | `labels/runner.py:241` |
| 出场常量 STOP_LOSS_THRESHOLD=-0.08 / MAX_HOLD_DAYS=20 / MA_WINDOW=5 | `strategy/exit_rules.py:38-40` |
| exit_reason 字面量 ma5_break/stop_loss/max_hold/force_close（下游禁改名） | `strategy/exit_rules.py:42-46` |
| `ExitState` 字段：current_price/low_price/ma5/hold_days+…，**无 high、无 peak** | `strategy/exit_rules.py:53-71` |
| `LABEL_SCHEME="strategy-aware"` 写死并写入 records | `labels/strategy_aware.py:87,505` |
| `LabelInputs.max_hold_days` 透传链已存在 | `labels/strategy_aware.py:274,433-444` |
| `base_scheme_codec` legacy-alias 套路；strategy_aware→"strategy-aware" | `labels/dir3_scheme.py:122-158` |
| `apply_hfq` 逐行 `× adj_factor`（close_adj/low_adj） | `labels/_common.py:43-65` |
| `_load_daily_quotes` SELECT 只取 close/low（**无 high**） | `labels/runner.py:75` |
| `runner_entrypoint` 未透传 max_hold_days（接线缺口） | `labels/runner.py:431-436` |
| 主路径 `train_e2e`：_validate_params→base_scheme_codec→_step_labels | `worker/train_e2e_runner.py:455,537-587` |
| `raw.daily_quote` 列含 open/high/low/close（high 可用） | `db/schema_contract.py:23` |
| 标签种子 `strategy_aware_default@v1` base_params={max_hold_days:20} | `db/migrations/versions/20260605_0001_label_definitions.py:55-66` |
| label_definitions 表结构 / 迁移 INSERT 用 CAST(:x AS jsonb) | 同上 `:103-168` |
| 实体双注册坑（forFeature + app.module 根 entities） | `entities/ml/label-definition.entity.ts:12-16` |
| 现有顶层 `strategies/`（StrategyEntity，crypto）→ 命名避碰 | 现有代码（用 `StrategyDefinition*`） |
