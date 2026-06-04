# 量化标签管理模块（quant-label-management）

- **日期**: 2026-06-05
- **范围**: 全栈（quant-pipeline / NestJS / Vue）
- **目标读者**: 后续承接此 spec 派发并行 agent 的开发者

## 摘要

量化模块当前**已有** `label_scheme` 机制（`strategy-aware` / `fwd_5d_ret` / `dir3_band` / `dir3_tercile` 四种），但标签类型**硬编码在 Python 代码 + 前端下拉框**里，每次训练手填参数、无法命名复用；且 `dir3` 类标签在 **labels 阶段就提前把涨跌幅离散成 0/1/2 物化进库**，横盘阈值 ε 编进 `scheme` 串、进 `feature_set_id` 哈希——改一次 ε 就是全新 scheme、labels + features 整张重算。

本设计新增一个**标签定义注册中心**（类比已有的 `factor_definitions` 因子注册表），让标签成为**可命名、可版本化、可复用**的实体；每条标签分**两层**：

- **基础层** `base_type`（`fwd_ret` / `strategy_aware`）+ `base_params`——只算/存**原始连续涨跌幅**一份；
- **分类层** `classify_mode`（`NULL`=连续/回归 · `band` · `tercile` · `custom`）+ `classify_params`——**不物化**，训练时动态套。

核心改造是**分类后移**：`factors.labels` 今后只存基础连续值，离散（涨/跌/横盘）从 labels 阶段移到 `training/runner.py`；`feature_set_id` 哈希只含 `base_scheme`（基础键），分类参数不进哈希——于是**同一份 `feature_matrix` 可喂给不同阈值训练，改 ε 不重算 labels/features**。`fwd_ret` 用 `horizon` 统一"第二天涨跌幅"(h=1)与"第 N 天涨跌幅"(h=N)。

## 目标与非目标

**目标**

1. 新增 `factors.label_definitions` 表 + `/quant/labels` 前端管理页（CRUD），标签可命名、版本化、复用
2. 标签两层模型：基础层（`base_type`+`base_params`）+ 分类层（`classify_mode`+`classify_params`），分类绑在标签定义上
3. 分类从 labels 阶段后移到训练时；`factors.labels` 只存基础连续涨跌幅，相同 `base_scheme` 的多条标签共享同一份数据，改阈值不重算
4. 训练入口从硬编码 `label_scheme` 下拉改为"挑一条命名标签"，后端展开成明文 `base_*`/`classify_*` 参数（方案 i），并透传 `label_id`/`label_version` 落 `ml.model_runs` 供可复现追溯
5. `fwd_ret(horizon)` 统一"第二天"(h=1)与"第 N 天"(h=N)涨跌幅；预置种子标签平滑过渡原 4 个 scheme

**非目标（YAGNI）**

- 加密货币市场——只做 A 股，与现有量化 pipeline 一致（`klines` 表无涨跌幅字段/无复权/7×24/无停牌退市概念，未接入量化训练）
- 前端编辑标签的"计算逻辑"——`base_type` 算法在 Python，新增类型走代码 PR
- 标签编辑审计历史表——用"语义字段版本不可变 + `created_at`"替代
- `label_winsorize` 归入标签定义——它是 features 层对连续 label 的截尾，保留为训练超参（与标签目标正交）
- DB 层 CHECK `base_type`/`classify_mode` 枚举——单一真相源在 Python labels 模块，DB 只保结构
- 分类规则绑训练任务的"临时覆盖"——分类绑标签定义，改阈值 = 新建版本或新标签

## 架构总览

```text
┌─ 前端 Vue ────────────────────────────────────────────────┐
│  新增 QuantLabelsView 标签库管理页（仿 QuantFactorsView）  │
│  训练入口 TrainE2EFields：label_scheme 下拉 → "挑命名标签" │
└───────────────────────┬───────────────────────────────────┘
                        │ REST /api/quant/labels
┌─ NestJS 后端 ─────────▼────────────────────────────────────┐
│  LabelsController + LabelsService（CRUD + expandForTraining）│
│  实体 LabelDefinitionEntity（factors.label_definitions）    │
│  建 job 时把命名标签展开成明文参数写进 ml.jobs.params       │
└───────────────────────┬───────────────────────────────────┘
                        │ ml.jobs 队列（机制不变）
┌─ Python pipeline ─────▼────────────────────────────────────┐
│  labels 阶段：只算/存【基础连续涨跌幅】到 factors.labels    │
│  training 阶段：读连续 label → 按分类规则【动态离散】       │
│                ▲ 改 ε 只重跑这一步，labels/features 不动    │
└────────────────────────────────────────────────────────────┘
```

## 子文档清单与阅读顺序

| 文档 | 主题 | 建议读它如果你… |
|------|------|----------------|
| [01-overview-and-data-model.md](./01-overview-and-data-model.md) | 两层标签模型 / `label_definitions` 表 / `feature_set_id` 哈希语义权衡 / 与现有 dir3_scheme 机制的关系 | 想理解整体设计与数据模型 |
| [02-python-pipeline.md](./02-python-pipeline.md) | `fwd_ret` 统一 / 分类后移 / `base_scheme_codec` / 向后兼容 / Python 文件域 | 准备改 Python 侧 |
| [03-backend.md](./03-backend.md) | 实体 + CRUD + `expandForTraining` + 版本化 + 实体双注册 + DTO | 准备改 NestJS |
| [04-frontend.md](./04-frontend.md) | 管理页 / 编辑 Modal / 训练入口改造 / `buildParams.ts` / 前端约束 | 准备写 Vue |
| [05-migration-and-seed.md](./05-migration-and-seed.md) | 单表 migration / 种子标签 / Alembic 对齐前置 / 验证 SQL | 准备写 Alembic migration |
| [06-validation-and-testing.md](./06-validation-and-testing.md) | fail-fast 校验 / model×classify 兼容矩阵 / 测试矩阵 | 写校验与测试 |
| [07-rollout.md](./07-rollout.md) | 实施批次 / 并行任务拆分 / 分层 commit / 重启 | 准备派发实现任务 |

**推荐阅读顺序**：`index.md → 01 → 02 → 03 → 04 → 05 → 06 → 07`。

**跨文档引用约定**：相对路径 + 锚点，如 `./02-python-pipeline.md#向后兼容`。

## 关键决策摘要（贯穿全文）

- **增量叠加 + 分类后移**：连续值标签（`strategy-aware`/`fwd_Nd`）链路基本不动；改造集中在 `dir3` 这一支——把提前离散改为训练时动态离散
- **分类绑标签定义**：一条命名标签 = 基础算法 + 分类规则，自包含；改阈值 = 新建版本（语义字段不可变）
- **方案 i（后端展开明文）**：`ml.jobs.params` 放展开后的 `base_*`/`classify_*` 明文 + 透传 `label_id`/`label_version`；Python 不新增对 `label_definitions` 表的读依赖
- **`feature_set_id` 哈希只含 `base_scheme`**：分类参数不进哈希——这是"改 ε 不重算"的根；代价是训练目标由 `feature_set + 标签定义` 共同确定，靠 `model_run` 记 `label_id/version` 追溯可复现
- **单一真相源在 Python**：`base_type`/`classify_mode` 合法枚举权威在 Python labels 模块，后端 DTO 镜像、DB 不加 CHECK
- **向后兼容靠历史数据**：老 `dir3_band`(默认 ε)/`dir3_band_epsNNNN`(非默认 ε)/`fwd_5d_ret` 的 `feature_matrix`/`model_run` 原样保留，靠库里已物化数据复现，不靠重跑老代码路径
- **只做 A 股**：复用现有基于 Tushare 表的 labels runner（`raw.daily_quote`+`adj_factor` 后复权、`stk_limit`/`suspend_d`）
