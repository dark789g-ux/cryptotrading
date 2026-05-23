# Train E2E + 新股门槛可配置 设计 spec

> 基于 PROMPT-new-listing-threshold.md(2026-05-23 用户锁死的 D-1 ~ D-12 决策)+ 三轮澄清结论汇编。

## 背景与目标

把 `QuantTrainTriggerModal.vue` 改造成**端到端编排器**:用户在一张表填好
`factor_version` / `label_scheme` / `new_listing_min_days` / `date_range` / 模型超参,
提交后单个 job 由 Python worker 顺序跑 `labels build → features build → train` 三步,
中间产出的 `feature_set_id` 自动派生,不需要用户手填。

实现路径:新增 `run_type='train_e2e'` 端到端流水线(PROMPT 方案 4)。

## 核心决策一览

| # | 决策 | 来源 |
|---|---|---|
| D-1 | `fwd_5d_ret`(兜底 scheme)也加新股过滤 | PROMPT |
| D-2 | 单一 `run_type='train_e2e'` job,worker 内部顺序执行三步 | PROMPT §I.1 |
| D-3 | 阈值在 labels 阶段生效(不在 train 时过滤行) | PROMPT |
| D-4 | `factor_version` / `label_scheme` / `new_listing_min_days` / `date_range` 都进 train Modal | PROMPT |
| D-5 | 单 job 集成,worker 占用接受 30 分钟+ | PROMPT |
| D-6 | 不实现断点续跑,失败 → 重提覆盖(upsert 幂等) | PROMPT |
| D-7 | 进度切片:labels 0-30%、features 30-60%、train 60-100% | PROMPT |
| D-8 | Modal 顶部 mode switch,默认端到端 | PROMPT |
| D-9 | optuna / seed_avg 不改造 | PROMPT |
| D-10 | `factor_version` 纯文本(无 `GET /factor-versions` 接口) | PROMPT + 仓库现状 |
| D-11 | `factors.feature_sets` 加列 `new_listing_min_days INTEGER` | PROMPT |
| D-12 | `feature_set_id` 哈希契约并入 `new_listing_min_days` | PROMPT |
| D-13 | 新增 `ml.jobs.result_payload jsonb` 列,装 feature_set_id + step 快照 | 第 1 轮澄清 |
| D-14 | 元信息(factor_version / label_scheme / new_listing_min_days)写入 `ml.model_runs.hyperparams` | 第 1 轮澄清 |
| D-15 | migration 顺带把 `train_e2e` 加进 `ml.jobs.run_type` CHECK 约束(不动既有 `monitor` bug) | 第 1 轮澄清 |
| D-16 | feature_set_id 预查复用:build 算出新哈希后 SELECT 同逻辑元组,命中即复用老 ID | 第 2 轮澄清 |
| D-17 | Modal 隐藏 `neutralize_cols / robust_z`,后端强制 default | 第 2 轮澄清 |
| D-18 | step 名走 `error_text` 首行前缀 `[step:<name>] <traceback>` | 第 2 轮澄清 |
| D-19 | 预拆 `TrainE2EFields.vue` 子组件 | 第 3 轮澄清 |
| D-20 | Modal 提交成功 toast 提示长任务排队 | 第 3 轮澄清 |
| D-21 | RunDetail/HyperparamsPanel 缺字段不展示(零修改) | 第 3 轮澄清 |
| D-22 | `factor_ids` 顺手加入 feature_set_id 哈希(原 builder 未含,系既有缺陷) | 设计 3/5 |
| D-23 | `train_model` 函数显式加 `extra_hyperparams` kwarg | 设计 4/5 |
| D-24 | 切片方案:大一统单 PR | 第三轮选择 |

## 子文档清单

| 文件 | 内容 | 阅读顺序 |
|---|---|---|
| [01-overview-and-dataflow.md](./01-overview-and-dataflow.md) | 总体架构、数据流图、与现有 run_type 的关系 | 1 |
| [02-db-schema.md](./02-db-schema.md) | DB migration(feature_sets 加列、jobs 加列、CHECK 扩展、唯一索引) | 2 |
| [03-python-labels-features.md](./03-python-labels-features.md) | labels(strategy_aware + fallback + runner)、features builder + 预查复用 | 3 |
| [04-worker-orchestration.md](./04-worker-orchestration.md) | train_e2e_runner、progress 切片、dispatcher 接线、CLI | 4 |
| [05-nestjs-frontend.md](./05-nestjs-frontend.md) | NestJS DTO、Modal 改造、TrainE2EFields 子组件、RunDetail、Jobs view | 5 |
| [06-testing-and-acceptance.md](./06-testing-and-acceptance.md) | 单测矩阵、验收命令、手工 e2e 截图清单 | 6 |
| [07-risks-and-rollback.md](./07-risks-and-rollback.md) | 风险登记、上线前自检、回滚预案 | 7 |

## 跨文档引用约定

- 相对路径 + 锚点:`./03-python-labels-features.md#预查复用机制`
- 决策代号引用:在正文中直接写 `D-16`,详见本 index 决策表

## 范围与非范围

**在范围内**:
- 单 job 编排(D-2)
- labels/features/train 三步 + 进度切片(D-7)
- 新股门槛 0/60/250 全谱可配,fwd_5d_ret 也支持(D-1)
- feature_set_id 哈希契约升级 + 预查复用(D-12, D-16)
- 前端 Modal 双模式切换(D-8, D-19)

**明确不在范围**:
- 断点续跑、缓存跳过未变更步骤(D-6)
- optuna / seed_avg 改造(D-9)
- 推理路径变更
- 多 worker 并发优化
- `GET /api/quant/factor-versions` 接口(D-10 降级纯文本)
- 修复 `ml.jobs.run_type` CHECK 缺 `monitor` 的既有 bug(D-15 边界)

## 验收门

1. 五段验收命令全部 0 退出(详见 [06-testing-and-acceptance.md](./06-testing-and-acceptance.md))
2. PR 描述含 7 张手工 e2e 截图(详见 06 文档)
3. 五段验收命令的输出贴 PR 描述
