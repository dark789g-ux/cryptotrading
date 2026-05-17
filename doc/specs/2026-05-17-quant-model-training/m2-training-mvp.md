# M2 · 标签 + LightGBM 训练 MVP 通路 + ml.jobs 骨架（3 周，可延 1 周）

> 本里程碑文档是 [00-index.md](00-index.md) 的子文档。
> **实施 agent 必读**：[01-pg-schema.md](01-pg-schema.md)、[02-quant-pipeline.md](02-quant-pipeline.md)、[03-nestjs-vue.md](03-nestjs-vue.md)、[04-error-quality-testing.md](04-error-quality-testing.md)。
> **方法论参考**：`doc/量化/04-标签设计.md`、`doc/量化/05-LightGBM训练体系.md`。

## 目标

从 `ml.jobs` 触发 → `model.txt` 落盘 → `ml.scores_daily` 写入的 end-to-end 跑通。**不追求模型质量、不接前端**。

## 交付物

1. `strategy/exit_rules.py`：MA5 出场 / -8% 止损 / max_hold 20 实现，**作为可被未来 A 股回测引擎导入的独立模块**（[05-risks.md](05-risks.md) §2）
2. `labels/strategy_aware.py` 调用 `exit_rules` 产生 doc/04 推荐方案标签，含 5 个坑全处理（涨跌停 / 停牌 / 新股 / 退市 / 强右偏）
3. `features/` 把因子 + 标签拼成训练矩阵（含中性化 / 标准化）
4. LightGBM LambdaRank 训练（doc/05 标准配置，**先单 fold**，先不接 Walk-Forward）
5. artifact 落到本地 `./artifacts/{model_run_id}/model.txt` + `meta.json`
6. inference 写 `ml.scores_daily`（含 `model_version`，且**进入 score_writer 前必跑推理前必检**，[04-error-quality-testing.md](04-error-quality-testing.md) §2）
7. NestJS `modules/quant/` 仅上 **jobs controller**（POST/GET /quant/jobs/*）+ SSE token endpoint；scores / runs / quality 三只读 controller **不在 M2**（移至 M3 与 UI 一并）
8. Python worker dispatcher 覆盖 `train` / `infer` 两个 `run_type`，含 [01-pg-schema.md](01-pg-schema.md) §4.2 进度写入 + heartbeat + cancel 响应
9. 训练前自动跑 quality 门禁；失败 → `ml.jobs.status='blocked'` + `blocked_reason`

## 估时弹性

M2 是整个 Roadmap 风险最高的一段（标签 5 坑 / PIT 实证 / 训练首次跑通）。若实际超过 3 周，允许延至 4 周；总 Roadmap 90 天有 5-10 天弹性可吸收（M0+M1+M2+M3+M4 = 12-13.5 周内）。

## 验收门槛

- 一次 `POST /quant/jobs { run_type:"train", params:{...} }` → `ml.model_runs` 出现一行 → `ml.scores_daily` 当日**所有出现在 `raw.daily_quote` 的股票均有评分**（行数严格相等，不允许少 1 行；多则报错）
- OOS NDCG@10 > 随机基线（≥ 0.01 即可，不需要好）
- `model.txt` 可被 LightGBM CLI 独立加载预测（验证 artifact 不依赖 Python pickle）
- `exit_rules.py` 有独立单测，覆盖 4 种出场路径（MA5 / 止损 / max_hold / 强制平仓）
- 数据质量被人为破坏（删一行因子）后 train job 必须 `blocked` 而非 `success`
- worker 模拟崩溃（kill -9）后，reaper 在 3 分钟内把 `status='running'` 行回收为 `pending`（[00-index.md](00-index.md) §3 重启行为）

## 任务拆解（建议交付顺序）

| # | 任务 | 文件域 | 估时 |
|---|---|---|---|
| 1 | `strategy/exit_rules.py` 出场规则模块 + 单测 4 路径 | `quant-pipeline/src/quant_pipeline/strategy/` + `tests/unit/` | 2 天 |
| 2 | `labels/strategy_aware.py` + 5 个坑处理 + 写 `factors.labels` | `quant-pipeline/src/quant_pipeline/labels/` | 3 天 |
| 3 | `features/` 中性化 + 标准化 + 写 `factors.feature_matrix` | `quant-pipeline/src/quant_pipeline/features/` | 2 天 |
| 4 | `training/lightgbm_lambdarank.py` 单 fold 训练 + artifact 落盘 | `quant-pipeline/src/quant_pipeline/training/` | 3 天 |
| 5 | `inference/runner.py` + score_writer + 推理前必检集成 | `quant-pipeline/src/quant_pipeline/inference/`、`quality/` | 2 天 |
| 6 | worker dispatcher 覆盖 train / infer + heartbeat + cancel | `quant-pipeline/src/quant_pipeline/worker/` | 2 天 |
| 7 | NestJS `modules/quant/` jobs controller + service + SSE token endpoint | `apps/server/src/modules/quant/` | 2 天 |
| 8 | 端到端联调：POST → train → infer → 验证 scores_daily 行数 | 全链路 | 2 天 |
| 9 | reaper 集成 + 模拟崩溃验证 | `worker/poller.py` | 1 天 |

## 与其它里程碑的依赖关系

- 依赖 M0（schema）、M1（因子 + 标签所需的 raw 数据 + factors.daily_factors）
- 阻塞 M3：M3 的三组对照、Walk-Forward、UI 评分看板都依赖本里程碑的 train / infer 通路 + ml.jobs 骨架

## 风险与注意事项

- ⚠️ strategy-aware labeling 是整个项目最大的工程坑：涨跌停日的"开盘买入"在 T+0 不可成交、停牌日的"持仓挂起"、新股次新股的早期波动、退市股的"强制平仓估值"、右偏分布的损失函数稳定性。这 5 个坑每个都需要在 `tests/unit/test_strategy_aware.py` 里有专门 case
- ⚠️ exit_rules.py 必须独立可被 `from quant_pipeline.strategy.exit_rules import ...` 导入；不允许把出场逻辑散落在 labels/strategy_aware.py 内联（否则未来回测引擎复用不了）
- ⚠️ LightGBM LambdaRank 要求样本按"日"分组（每日为一个 query group），feature_matrix 排序 / group_id 字段必须正确，否则 NDCG 计算无效
- ⚠️ artifact 路径使用 POSIX 风格存库（[05-risks.md](05-risks.md) §6）
- ⚠️ SSE token endpoint 是 `AuthGuard` 全局规则的合法例外（[03-nestjs-vue.md](03-nestjs-vue.md) §1）；controller 上必须有显式注释说明
