# 冒烟验证 · lgb 超参 + 特征参数 + lgb-multiclass（PR #5）

> 先读本目录 [README.md](./README.md) 的共享背景与通用约束，再读本文件。

## 目的

PR #5 已合入 main。其单元测试（含 lgb-multiclass e2e）用 **fake lightgbm + mock DB** 跑过，
但有两块**未在真栈验证**：

1. lgb-multiclass 用**真实 lightgbm**训练/推理是否跑通（单测里 `lgb` 被 `fake_lgb` fixture 替换）。
2. 带**真实 Postgres**的完整链路：前端创建任务 → NestJS → Python worker → 训练落 `ml.model_runs`
   → 推理写 `ml.scores_daily` → 前端展示。

本任务做这两级冒烟，确认功能真实可用，不只是单元层绿灯。

## 前置：环境与依赖

Python 子项目在 `apps/quant-pipeline/`，运行测试用 `PYTHONPATH=src python3 -m pytest`
（包未 editable 安装，靠 PYTHONPATH=src 导入）。

**依赖**：需 `torch / scikit-learn / shap / optuna / psycopg2 / lightgbm` 齐全。
先探测，缺则装（本环境网络策略允许 PyPI；注意 pytorch.org 索引可能被墙，torch 直接从默认 PyPI 装）：
```bash
cd apps/quant-pipeline
python3 -c "import torch,sklearn,shap,optuna,psycopg2,lightgbm; print('all deps present')" \
  || python3 -m pip install torch scikit-learn shap optuna psycopg2-binary lightgbm
```

## Level 0 · 健全性（必跑，无需 DB / docker）

确认 PR 相关单测在本环境全绿——这是后续冒烟的地基。
```bash
cd apps/quant-pipeline
PYTHONPATH=src python3 -m pytest \
  tests/unit/test_feature_set_hash.py \
  tests/unit/test_lgb_multiclass.py \
  tests/unit/test_train_e2e_validate_passthrough.py \
  tests/unit/test_labels_fwd_horizon_param.py \
  tests/unit/test_labels_strategy_aware_max_hold.py \
  tests/unit/test_lstm_metrics.py \
  tests/unit/test_train_e2e_runner.py -q
```
期望：全 passed（参考基线 115 passed）。

> 注：仓库内另有 ~16 个 `test_factor_compute_unchanged` + `test_factors_runner` /
> `test_inference_score_writer` 因 numpy/pandas/lightgbm 版本漂移导致 **golden-hash 失配**，
> **与本 PR 无关**（PR 未触碰 factors/score_writer）。不要把它们误判为本次回归——
> 判定方法：这些文件不在 PR #5 的改动清单内。

## Level 1 · 真实 lightgbm 端到端（无需 DB，推荐先做）

单测的 `test_train_lgb_multiclass_end_to_end` 用 `fake_lgb` 替换了 lightgbm，并 mock 了
`_load_feature_matrix` / `gate_check` / `load_forward_returns`。本级要**用真实 lightgbm**重跑，
确认 `objective=multiclass,num_class=3` 在真实 booster 上训练 + `booster.predict` 出 (N,3) 概率
+ `score=P(涨)−P(跌)` + rank 全程无误。

做法（写一个一次性脚本，**不要**提交进仓库，放 `/tmp` 跑完即弃）：

1. 参照 `tests/unit/test_lgb_multiclass.py::_synthetic_feature_matrix`（line ~182）构造一个
   小而**可学习**的 dir3 特征矩阵（足够覆盖 6 折 walk-forward 的 `min_train_days`，
   或把 `walk_forward_params` 调小到能跑：n_folds 可保 6，但需足够交易日；不行就直接调用
   底层单折训练函数验证 booster 训练+预测）。
2. **不** monkeypatch lightgbm（用真实库）；仅 mock 掉 DB 依赖：`_load_feature_matrix` 返回你的
   合成矩阵、`gate_check` no-op、`load_forward_returns` 返回随机小收益、`insert_model_run`
   收集落库参数到 dict。
3. 调 `train_lgb_multiclass_model(...)`，断言：
   - `model_version == "lgb-multiclass-v1-<today>-seed<N>"`
   - artifact 目录产出 `model.txt`（真实 LightGBM booster，可 `lgb.Booster(model_file=...)` 回载）
     + `meta.json`（`algorithm=="lgb-multiclass"`、`class_order==["down","flat","up"]`、
     `num_class==3`、含 `feature_columns_order`）
   - `oos_metrics.task=="classification_3class"`，含 accuracy / macro_f1 / per_class /
     confusion_matrix / ic / rank_ic / fold_metrics
4. 用回载的 booster 跑一次 `predict`，手工核验 `score=P(涨)−P(跌)` 公式与 rank 降序逻辑
   （可直接调 `inference/lgb_multiclass_predictor` 里抽出的纯函数，或复刻其 score 计算比对）。

期望：真实 lightgbm 训练/预测跑通，meta / oos_metrics 结构与 spec 03 一致。把脚本与输出贴出来。

## Level 2 · 全链路（需 Postgres + docker，可能本环境不可用）

**前提**：docker daemon 必须可用（`docker ps` 不报 socket 错）。本功能开发容器里
docker **未起**（`pnpm db:start` 会失败）——若当前会话同样不可用，**跳过 Level 2 并明确记录"环境无 docker，未执行"**，不要伪装跑过。

可用时：
```bash
pnpm install            # 若 node_modules 缺失
pnpm db:start           # docker compose up -d postgres
# 跑迁移（确认 ml.* / factors.* schema 就位）；参考 apps/server/migrations/*.ps1 的 docker exec 调用
pnpm dev                # server :3000 + web :5173
```
然后在前端「创建训练」走两条用例：

A. **lgb-lambdarank E2E + 自定义超参 + 特征参数**
   - 选 model=lgb-lambdarank、E2E 模式，展开「模型超参」改几个值（如 num_leaves=63、
     learning_rate=0.03）、展开「特征/标签参数」改 robust_z=off、factor_clip_sigma=2.5。
   - 提交后 SSE 进度推进；完成后查库确认超参真的落库、且特征参数改变了 feature_set_id：
     ```bash
     docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
       "SELECT model_version, feature_set_id, hyperparams FROM ml.model_runs ORDER BY created_at DESC LIMIT 3;"
     ```
   - 验证「全默认配置」时 feature_set_id 与历史一致（方案A 回归红线）：另跑一个**全默认**任务，
     确认其 feature_set_id 命中既有 row（或与改动前同算法所得一致）。

B. **lgb-multiclass**
   - 选 model=lgb-multiclass，确认前端自动把 label_scheme 切到 dir3_band、walk_forward 锁定 true。
   - 提交跑通后做一次 infer，查 `ml.scores_daily`：
     ```bash
     docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
       "SELECT count(*) FROM ml.scores_daily WHERE model_version LIKE 'lgb-multiclass%';"
     ```
   - 确认行数 == 当日 `raw.daily_quote` 全量股票数（M2 硬约束，缺票补 NaN）；score 有正有负
     （P涨−P跌 合理分布）、rank_in_day 按 score 降序、NaN 排末尾。

C. **factor_version 下拉** + **early_stopping 禁用**
   - 创建表单里 factor_version 是下拉（非文本框），至少有 `v1`。
   - 普通 train 模式（非 E2E）选 lgb 系，`early_stopping_rounds` 字段 disabled 且有 tooltip。

## 通用约束（重申）

- 这是验证任务，**默认不改生产代码**。Level 1 的脚本放 `/tmp`，不进仓库。
- 若冒烟暴露真实 bug：走 `systematic-debugging`，新建分支修，禁止直接推 main，
  改完补单测。
- 收尾按 `verification-before-completion`：每一级都贴**真实命令输出**，
  Level 2 不可用就如实写"环境无 docker，未执行"，禁止凭空声称通过。

## 验证产出（交回主人）

- Level 0：pytest 输出（passed 数）。
- Level 1：脚本 + 真实 lightgbm 训练/推理输出 + meta.json / oos_metrics 摘要。
- Level 2：执行了就贴 SQL 查询结果（hyperparams 落库、scores_daily 行数对齐、
  feature_set_id 默认不变 / 非默认变化）；没执行就写明原因。
