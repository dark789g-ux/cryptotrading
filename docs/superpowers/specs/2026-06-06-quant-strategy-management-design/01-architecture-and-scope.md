# 01 · 架构与范围

← 返回 [index](./index.md)

## 1. 总览数据流

```text
┌─ 前端 /quant/strategies （策略管理页） ─────────────────────────┐
│  列表 + 状态筛选 + 新建/编辑                                     │
│  StrategyEditModal → ExitRulesEditor（动态规则列表，5 种 type）  │
│                                                                  │
│  标签编辑弹框 BaseTypeFields：base_type=strategy_aware 时        │
│    原 max_hold_days 数字框  ──替换──▶  策略选择器（enabled 列表） │
└───────────────┬──────────────────────────────────────────────────┘
                │ /api/quant/strategies  （CRUD, AdminGuard）
┌───────────────▼──────────────────────────────────────────────────┐
│  NestJS modules/quant/strategies/                                 │
│   StrategyDefinitionEntity ↔ factors.strategy_definitions         │
│   建 strategy_aware 标签时校验引用的策略存在且 enabled            │
└───────────────┬──────────────────────────────────────────────────┘
                │ 建训练 job → expandForTraining 展开
                │ base_params = { strategy_id, strategy_version }
┌───────────────▼──────────────────────────────────────────────────┐
│  Python quant-pipeline（labels stage）                            │
│   ① base_scheme_codec(strategy_aware, {id,ver}) → scheme          │
│   ② load_strategy_definition(id, ver) → exit_rules (jsonb)        │
│   ③ build_exit_rules(exit_rules) → ExitRule 链                    │
│   ④ compute_strategy_aware_labels(..., exit_rules, scheme)        │
│      → simulate_exit → factors.labels(scheme, value, ...)         │
└──────────────────────────────────────────────────────────────────┘
                ▲
   DB: factors.strategy_definitions（Alembic 迁移 + 种子 default_exit@v1）
```

## 2. 两条 label 入口（都要接线）

标签计算有两条进入 `compute_labels` 的路径，**两条都要改**：

```text
路径 A（主路径，前端训练入口走这条）:
  NestJS expandForTraining → ml.jobs.params{base_type, base_params, ...}
   → worker.run_train_e2e → _validate_params（校验 strategy 引用）
   → base_scheme_codec → _step_labels（解析 strategy→exit_rules）
   → compute_labels(scheme, exit_rules=...)
        出处: worker/train_e2e_runner.py:455, 537-587

路径 B（dispatcher 直跑 run_type='labels'）:
  ml.jobs.params{scheme, date_range, ...}
   → worker.dispatcher → labels.runner.runner_entrypoint
   → compute_labels(...)
        出处: labels/runner.py:413-436
        ⚠ 现状连 max_hold_days 都没透传，需补 strategy 解析
```

设计约束：**策略解析（DB 查 strategy_definitions）放在 runner/worker 层**（DB IO 归属层，
见 `labels/runner.py` docstring），`build_exit_rules` 与 `compute_strategy_aware_labels`
只吃**已解析好的** `exit_rules` 配置（纯函数，不碰 DB）。

## 3. 命名避碰（硬约束）

项目已存在顶层 `apps/server/src/strategies/`（`StrategyEntity` / `StrategiesService`，
**纯加密货币回测**域）。新模块一律用区分命名，杜绝混淆：

| 概念 | 现有（勿动） | 新建 |
|------|------|------|
| 实体类 | `StrategyEntity` | `StrategyDefinitionEntity` |
| DB 表 | `public.strategies` | `factors.strategy_definitions` |
| Service | `StrategiesService`（顶层） | `QuantStrategiesService`（modules/quant 下） |
| 路由 | `/api/strategies` | `/api/quant/strategies` |
| 前端页 | strategy 视图组 | views/quant 下 |

## 4. v1 范围边界（YAGNI）

**做：**
- 策略定义注册中心（DB 表 + Alembic 迁移 + 种子）。
- 5 种出场规则 type，含为 take_profit/trailing_stop 改造模拟器（加 high/peak 状态）。
- NestJS CRUD + DTO discriminated-union 校验 + 标签引用校验。
- 前端策略管理页 + ExitRulesEditor + 标签弹框策略选择器。
- 标签 `strategy_aware` base_params 改 `{strategy_id, strategy_version}` + 数据迁移。

**明确不做（留后续版本，注册中心架构已预留扩展位）：**
- 入场 / 选股条件（标签密集→稀疏的语义变更）。
- 调仓 / 仓位 / 组合参数（组合层，不影响单股标签值）。
- crypto 市场 / 跨市场统一策略系统。
- 策略回测可视化、收益曲线展示（只产 ML 标签，不做交互式回测）。

## 5. 关键不变式

- **标签可复现**：策略不可变版本（D5）→ `(strategy_id, strategy_version)` 唯一确定 exit_rules
  → scheme 决定性 → `factors.labels` 行可复现。
- **default 零漂移**：`default_exit@v1` 的规则 = 现写死规则，scheme 回 legacy 别名
  `"strategy-aware"`，**历史 `factors.labels` 行无需重算**（回归校验见
  [`./06-testing-and-tasks.md#回归校验`](./06-testing-and-tasks.md#回归校验)）。
- **不串味**：不同策略 → 不同 scheme → `factors.labels` PK `(trade_date, ts_code, scheme)`
  天然隔离（出处 `runner.py:241`）。
