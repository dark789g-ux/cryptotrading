# Agent 交接提示词 · lgb 超参 + 特征参数 + lgb-multiclass 冒烟验证

本目录存放给**新会话 agent**接手的自包含提示词。每个文件可直接整段贴给一个新 agent，
无需本会话上下文。

## 背景（所有提示词共享）

`cryptotrading` 量化模块已在 PR #5 合入 main（squash commit `0a9a1fc`），新增/改动：

- **lgb 超参表单**：`LgbHyperFields.vue`，9 个 LightGBM 树参数，普通 train + E2E 双入口。
- **特征/标签参数暴露**：`FeatureLabelFields.vue`（仅 E2E），neutralize_cols / robust_z /
  factor_clip_sigma / label_winsorize / fwd_horizon_days / max_hold_days，经严格校验透传，
  并按"方案A：仅非默认入哈希"纳入 `feature_set_id`（见 `features/feature_set_hash.py`）。
- **factor_version 动态下拉**：`GET /api/quant/factor-versions`。
- **lgb-multiclass**：LightGBM 三分类（跌/横盘/涨），独立 walk-forward 训练/推理/评估，
  吃 dir3 标签，`score=P(涨)−P(跌)`；公共三分类指标抽到 `training/classification_metrics.py`。

设计 spec（务必先读）：`docs/superpowers/specs/2026-05-30-lgb-hyperparams-and-multiclass-design/`
（入口 `index.md`，5 个子文档）。

核心文件：
```
apps/quant-pipeline/src/quant_pipeline/
├─ worker/train_e2e_runner.py            ValidatedParams + _validate_params 严格校验 + 透传
├─ features/feature_set_hash.py          覆盖层哈希（方案A，全默认 id 不变）
├─ features/runner.py                    build_feature_matrix 透传特征参数 + 哈希
├─ labels/{runner,fallback,strategy_aware}.py  标签参数（fwd_horizon/max_hold/winsorize）入参化
├─ training/runner.py                    model 分派（lgb-lambdarank/lgb-multiclass/lstm）
├─ training/lgb_multiclass_walk_forward.py   lgb-multiclass 训练主路径
├─ training/lgb_multiclass_metrics.py        lgb-multiclass oos_metrics
├─ training/classification_metrics.py        公共三分类指标（lstm 与 lgb-multiclass 共用）
├─ inference/runner.py                    按 meta.algorithm 分派
└─ inference/lgb_multiclass_predictor.py     推理：booster.predict → score=P涨−P跌 → scores_daily
apps/server/src/modules/quant/factors/   factor-versions controller/service
apps/web/src/components/quant/train-modal/  LgbHyperFields / FeatureLabelFields / TrainE2EFields / buildParams
```

## 本目录提示词清单

| 文件 | 任务 | 依赖 |
|------|------|------|
| [smoke-lgb-multiclass.md](./smoke-lgb-multiclass.md) | lgb 系新功能端到端冒烟验证（真栈，分两级：无 DB / 带 DB） | 见文件内 |

## 通用约束（所有 agent 必读）

- 先读仓库根 `CLAUDE.md`（核心规范 + 硬约束），尤其：禁静默吞错、外部空数据双路径 warn、
  时间列 timestamptz、UTF-8、单文件 ≤500 行、A 股 trade_date 是 YYYYMMDD 字符串禁直接 `new Date`。
- 这是**验证任务，默认不改生产代码**；若冒烟暴露真实 bug，先暴露问题、走 `systematic-debugging`，
  改动须新建分支（如 `claude/lgb-smoke-fix-xxxx`），禁止直接推 main。
- 完成后按 `verification-before-completion`：贴**真实命令输出**再下"通过/失败"结论，
  不要凭推断声称通过。
