# M4 · 训练 run UI + SHAP + Optuna + Seed Averaging + 监控（3 周）

> 本里程碑文档是 [00-index.md](00-index.md) 的子文档。
> **实施 agent 必读**：[01-pg-schema.md](01-pg-schema.md)、[02-quant-pipeline.md](02-quant-pipeline.md)、[03-nestjs-vue.md](03-nestjs-vue.md)、[04-error-quality-testing.md](04-error-quality-testing.md)、[05-risks.md](05-risks.md)。
> **方法论参考**：`doc/量化/01-训练体系蓝图.md`（部署监控）、`doc/量化/05-LightGBM训练体系.md`（Optuna 主旋钮）。

## 目标

可运营 / 可解释 / 可监控。

## 交付物

1. `QuantRunDetailView`：超参 / fold 表 / SHAP top-20 柱状图 / `model.txt` 下载
2. `QuantJobsView` + `QuantTrainTriggerModal`（弹窗触发训练 / 触发 Optuna / 触发 Seed Averaging）
3. SSE 进度推送 + PG `LISTEN ml_job_progress` 通道 + SSE token 鉴权（[03-nestjs-vue.md](03-nestjs-vue.md) §1）
4. Optuna 调参（doc/05 四个主旋钮：`num_leaves` / `min_data_in_leaf` / `feature_fraction` / `learning_rate`）作为独立 `run_type='optuna'`；**必须使用 Optuna PG RDB storage**（不允许 in-memory），使中断可恢复（[05-risks.md](05-risks.md) §9）
5. Seed Averaging（5 seed 平均）作为 `run_type='seed_avg'`，每个 seed 一个 child job（`parent_job_id` 指向父）
6. 监控：**每日推理后**自动算 IC / 评分分布 / 与上次的特征漂移 PSI，超阈值落 `ml.quality_reports(level=warn|critical)`，规则名见 [01-pg-schema.md](01-pg-schema.md) §4.3 (`feature_drift_psi` / `ic_drop`)
7. cron / Windows 任务计划脚本模板：**每日 22:00 触发** `sync → quality → infer` 链（避开 18:00 当日数据尚未全发布的窗口；各表最早可用时点见下方附录）
8. 复盘报告：本机 CPU 跑当前规模因子 / 模型 / 调参的时延实测；判断是否需扩容（仅给结论，不做实现）
9. Vue 单文件 ≤ 500 行的 CI 校验脚本（pre-commit hook 或 lint rule），所有 `views/quant/**` 文件强制走

## 验收门槛

- 在 web 上点"触发训练" → 进度条实时滚动（< 2 秒延迟，且 SSE 重连后能立即拿到当前 progress；[00-index.md](00-index.md) §3）→ 完成后 RunDetail 显示 SHAP
- Optuna 一次完整调参（≥ 50 trial）能跑完且 best_trial 落 `ml.model_runs`；中途 kill Python 进程后重启，trial 进度可从断点恢复
- 模拟一次特征漂移（人为篡改输入分布）→ `ml.quality_reports` 产生 `critical` 行 → 前端 Overview 顶部告警条
- 任务计划脚本在本地连续运行 3 个交易日无人值守；定义"成功"为：每日 22:30 前 `ml.scores_daily` 当日股票数 = `raw.daily_quote` 当日股票数；定义"失败"为：任意一天有 `ml.jobs.status='failed'` 或 `'blocked'` 且未人工介入
- 单文件 ≤ 500 行 CI 校验通过；`QuantRunDetailView` 拆分后所有子文件均 ≤ 500 行

## 任务拆解（建议交付顺序）

| # | 任务 | 文件域 | 估时 |
|---|---|---|---|
| 1 | `training/tuning.py` Optuna 4 主旋钮 + PG RDB storage 接入 | `quant-pipeline/src/quant_pipeline/training/tuning.py` | 3 天 |
| 2 | `training/seed_averaging.py` + parent_job_id 父子关系 | `quant-pipeline/src/quant_pipeline/training/seed_averaging.py`、worker dispatcher | 2 天 |
| 3 | `evaluation/shap_explainer.py` + 写 shap_uri | `quant-pipeline/src/quant_pipeline/evaluation/shap_explainer.py` | 2 天 |
| 4 | 监控：IC 滚动 / 特征 PSI 计算 / 写 `ml.quality_reports` | `quant-pipeline/src/quant_pipeline/quality/monitor.py`（新增） | 2 天 |
| 5 | NestJS SSE controller + SSE token endpoint 完善 + LISTEN/NOTIFY 桥接 | `apps/server/src/modules/quant/realtime/` | 2 天 |
| 6 | Vue `QuantRunDetailView` + ShapBarChart + 拆分子组件至 ≤ 500 行 | `apps/web/src/views/quant/` + `components/quant/` | 4 天 |
| 7 | Vue `QuantJobsView` + `QuantTrainTriggerModal` + `ProgressLine` SSE | 上同 | 3 天 |
| 8 | Windows 任务计划脚本模板 + 3 日无人值守演练 | `scripts/`（新增） | 1 天 |
| 9 | Vue ≤500 行 CI 校验脚本（pre-commit / lint rule） | `apps/web/` | 1 天 |
| 10 | 复盘报告（本机 CPU 实测时延 + 扩容建议） | 文档 | 1 天 |

## 与其它里程碑的依赖关系

- 依赖 M3 完成（评估管线 + UI 骨架）
- 本里程碑完成 = Roadmap 终点

## 附录：A 股 raw 表当日最早可用时点（任务计划依赖）

> 实际经验值，M1 首次同步时需在 ml.quality_reports 中观察并修正。

| 表 | 最早可用 | 备注 |
|---|---|---|
| `raw.daily_quote` | T 日 17:30 | 个别股票延后到 18:30 |
| `raw.daily_basic` | T 日 18:00 | PE/PB 等需收盘价计算 |
| `raw.adj_factor` | T 日 18:30-20:00 | 不稳定，建议 21:00 后拉 |
| `raw.daily_indicator` | T 日 20:00 后 | 项目自算，依赖前 3 项 |
| `raw.stk_limit` | T 日 17:00 | 收盘即固定 |
| `raw.suspend_d` | T 日 17:00 | 交易所公告口径 |
| `raw.fina_indicator` | 公告日，盘前/盘后均可能 | 强制以 `ann_date` 入库 |

**结论**：cron 触发时刻 ≥ 21:00，推荐 **22:00**（给 adj_factor 留 1 小时缓冲）。若需更早，可在 T+1 早 09:00 跑（更稳但延迟一天）。

## 风险与注意事项

- ⚠️ Optuna PG RDB storage 会在 `ml` schema 下建一组 `optuna_*` 表，由 Optuna 库自己创建（不走 Alembic）；详见 [05-risks.md](05-risks.md) §9
- ⚠️ reaper 与 worker 同进程同生命周期（[05-risks.md](05-risks.md) §8）；M4 不要把 reaper 拆成单独服务
- ⚠️ SHAP 计算对 5500 标的 × 30 特征是分钟级，可接受；若 M4 复盘报告显示扩到 100+ 因子时 > 30 分钟，则建议只对 Top-K 重要因子做 SHAP（在 RunDetail UI 上明示）
- ⚠️ `QuantRunDetailView` 容易超 500 行，建议从一开始就拆 4-6 个子组件（HyperparamsPanel / FoldTable / ShapBarChart / DownloadActions / OverviewHeader 等）
- ⚠️ 任务计划脚本"成功"必须在 22:30 前完成；若 raw 同步在 22:00 - 22:30 间未稳定到位，可推迟到 22:30 触发，但需更新本附录的"结论"段
