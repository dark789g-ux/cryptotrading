# M3 · Walk-Forward 评估 + 三组对照 + 前端评分看板（3-3.5 周）

> 本里程碑文档是 [00-index.md](00-index.md) 的子文档。
> **实施 agent 必读**：[01-pg-schema.md](01-pg-schema.md)、[02-quant-pipeline.md](02-quant-pipeline.md)、[03-nestjs-vue.md](03-nestjs-vue.md)、[04-error-quality-testing.md](04-error-quality-testing.md)。
> **方法论参考**：`doc/量化/05-LightGBM训练体系.md`（Walk-Forward + 三组对照 + 扣成本年化）。

## 目标

把"能跑"变成"可信"，且产出第一个可看的 UI。

## 交付物

1. Purged Walk-Forward（embargo ≥ 21 日）正式接入 `training/runner.py`
2. **三组对照实验**：线性 baseline / GBDT 单模 / 集成，OOS 指标三栏并排写 `ml.model_runs.oos_metrics`
3. 评估扣成本：佣金 + 滑点的 portfolio 年化（doc/05）
4. 自动报告生成：`./artifacts/{model_run_id}/report.md`，含三组对照表 + 每折指标
5. NestJS `modules/quant/`：**新增 scores / runs / quality 三只读 controller + 对应 service**（从 M2 移入），含 FIELD_COL_MAP 字段映射（CLAUDE.md 动态 SQL 规范）
6. Vue：`/quant` Overview + `/quant/scores` + `/quant/runs` 三页 + 共享组件（ScoreTable / MetricBadge）
7. 模型版本切换器（query string + URL 同步）

## 验收门槛

- 三组对照实验报告自动生成且可下载
- **GBDT vs 线性 OOS NDCG@10 绝对值提升 ≥ 0.015**（例如 0.500 → ≥ 0.515；非相对 3%）；不达不能进 M4，需排查标签 / 因子
- Walk-Forward fold ≥ 6 折，每折 IC / NDCG / 扣成本年化均有记录
- 前端三页手测主流程无 5xx；列表分页、模型版本切换、Top-K 调整均工作
- 同一交易日 `ml.scores_daily` 两个 `model_version` 共存查询无串扰
- scores 查询接口在 5500 标的 × 4 年历史规模下 P95 < 500ms（PG 索引验收）

## 任务拆解（建议交付顺序）

| # | 任务 | 文件域 | 估时 |
|---|---|---|---|
| 1 | `training/walk_forward.py` Purged + embargo ≥ 21 日 + 折分配 | `apps/quant-pipeline/src/quant_pipeline/training/walk_forward.py` | 3 天 |
| 2 | `training/runner.py` 接入 Walk-Forward；fold_metrics 写 oos_metrics | `apps/quant-pipeline/src/quant_pipeline/training/runner.py` | 1 天 |
| 3 | 线性 baseline + GBDT 单模 + 集成（3 模型并跑） | `apps/quant-pipeline/src/quant_pipeline/training/` | 3 天 |
| 4 | `evaluation/portfolio.py` 扣成本年化（佣金 + 滑点） | `apps/quant-pipeline/src/quant_pipeline/evaluation/portfolio.py` | 2 天 |
| 5 | `evaluation/ab_compare.py` + 自动报告生成 `report.md` | `apps/quant-pipeline/src/quant_pipeline/evaluation/` | 1 天 |
| 6 | NestJS scores / runs / quality 三只读 controller + service + FIELD_COL_MAP | `apps/server/src/modules/quant/` | 3 天 |
| 7 | Vue Overview + Scores + Runs 三页 + ScoreTable / MetricBadge | `apps/web/src/views/quant/` | 4 天 |
| 8 | 模型版本切换器（query string + URL 同步） | 上同 | 1 天 |
| 9 | 验收：跑一次完整 train+evaluate，验证报告与门槛 | 全链路 | 2 天 |

## 与其它里程碑的依赖关系

- 依赖 M2 完成（train / infer 通路 + ml.jobs 骨架）
- 阻塞 M4：M4 的 SHAP / 触发 UI / 监控都依赖本里程碑的 controller / UI 骨架

## 风险与注意事项

- ⚠️ Purged Walk-Forward 的 embargo 必须 ≥ 21 日（A 股财报披露窗口），否则训练集会用到测试集发布过的财务信息（PIT 泄漏）
- ⚠️ "GBDT vs 线性 ≥ 0.015 绝对值"是阻塞门槛，不达不能进 M4。不达的常见原因：标签噪音过大（回到 M2 调 strategy-aware 5 个坑）/ 因子覆盖不全（回到 M1 加因子）/ 中性化没做（回到 features/）
- ⚠️ 三组对照的"集成"建议简单平均 + 标准化排名，不要在 M3 就上 stacking（留 M4）
- ⚠️ FIELD_COL_MAP 是 CLAUDE.md 硬约束（动态 SQL 字段映射）；scores controller 的 filter / sort 必须经过映射表翻译，未命中字段记 `logger.warn` 并 skip
- ⚠️ 前端模型版本切换器同步到 URL query string（便于分享链接）；切换时若新 model_version 当日无数据，UI 要给出明确空态而非 5xx
